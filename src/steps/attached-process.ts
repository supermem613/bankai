import { spawn } from "node:child_process";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { z } from "zod";
import { registerStep, type StepContext, type StepRunResult } from "./registry.js";
import { BindingPathRefSchema, resolveBindingPath } from "../bindings.js";
import { ReadinessProbeRefSchema } from "../plan/schema.js";
import { getReadinessProbe } from "../readiness/registry.js";
import { evaluateReadiness } from "../readiness/evaluate.js";
import type { ProcessHandle, ReadinessObservation } from "../registry/types.js";
import { CommandNotFoundError, resolveCommand } from "../spawn/resolve-command.js";

const WINDOWS_CTRL_C_EXIT = -1_073_741_510;
const WINDOWS_CTRL_C_EXIT_UNSIGNED = 3_221_225_786;

const OutputMatchSchema = z.object({
  id: z.string().min(1),
  stream: z.enum(["stdout", "stderr", "any"]).default("any"),
  contains: z.string().min(1).optional(),
  regex: z.string().min(1).optional(),
  flags: z.string().regex(/^[dgimsuvy]*$/).optional(),
}).strict().superRefine((match, ctx) => {
  const matcherCount = (match.contains ? 1 : 0) + (match.regex ? 1 : 0);
  if (matcherCount !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "output matcher must set exactly one of contains or regex",
    });
  }
  if (match.regex) {
    try {
      new RegExp(match.regex, match.flags);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : String(err),
        path: ["regex"],
      });
    }
  }
});

export const AttachedProcessStepV1Schema = z.object({
  kind: z.literal("attached-process"),
  id: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: BindingPathRefSchema.optional(),
  registerAs: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().default(60_000),
  requireVisibleTerminal: z.boolean().default(true),
  successExitCodes: z.array(z.number().int()).default([0, 130, 143, WINDOWS_CTRL_C_EXIT, WINDOWS_CTRL_C_EXIT_UNSIGNED]),
  stdio: z.enum(["inherit", "pipe"]).default("pipe"),
  resolveCommand: z.boolean().default(true),
  readyWhen: z.array(OutputMatchSchema).default([]),
  failWhen: z.array(OutputMatchSchema).default([]),
  verifyReady: z.array(ReadinessProbeRefSchema).default([]),
  readyEventFile: BindingPathRefSchema.optional(),
  announceReady: z.boolean().default(true),
  continueOnFail: z.boolean().optional(),
  alwaysRun: z.boolean().optional(),
}).strict().superRefine((spec, ctx) => {
  if (spec.stdio === "inherit" && (spec.readyWhen.length > 0 || spec.failWhen.length > 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "stdio must be pipe when readyWhen or failWhen is configured",
      path: ["stdio"],
    });
  }
  spec.verifyReady.forEach((ref, index) => {
    const probe = getReadinessProbe(ref.kind);
    if (!probe) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `unknown readiness probe kind: ${ref.kind}`,
        path: ["verifyReady", index, "kind"],
      });
      return;
    }
    const parsed = probe.configSchema.safeParse(ref);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: issue.message,
          path: ["verifyReady", index, ...issue.path],
        });
      }
    }
  });
});

export type AttachedProcessStepV1 = z.infer<typeof AttachedProcessStepV1Schema>;
type OutputMatch = z.infer<typeof OutputMatchSchema>;

interface ResolvedCommand {
  command: string;
  args: string[];
  detail: string;
  windowsVerbatimArguments?: boolean;
}

interface MatchedOutput {
  id: string;
  stream: "stdout" | "stderr";
  line: string;
}

export function resolveAttachedCommand(spec: AttachedProcessStepV1, ctx: StepContext): ResolvedCommand {
  if (!spec.resolveCommand) {
    return { command: spec.command, args: spec.args, detail: spec.command };
  }
  const r = resolveCommand(spec.command, spec.args, ctx.env);
  return {
    command: r.command,
    args: r.args,
    detail: r.detail,
    windowsVerbatimArguments: r.windowsVerbatimArguments,
  };
}

function findOutputMatch(
  matches: OutputMatch[],
  stream: "stdout" | "stderr",
  line: string,
): MatchedOutput | undefined {
  for (const match of matches) {
    if (match.stream !== "any" && match.stream !== stream) {
      continue;
    }
    if (match.contains && line.includes(match.contains)) {
      return { id: match.id, stream, line };
    }
    if (match.regex && new RegExp(match.regex, match.flags).test(line)) {
      return { id: match.id, stream, line };
    }
  }
  return undefined;
}

async function runAttachedProcess(spec: AttachedProcessStepV1, ctx: StepContext): Promise<StepRunResult> {
  const resolvedCwd = resolveBindingPath(spec.cwd, { workDir: ctx.workDir, bindings: ctx.bindings });
  let resolvedCommand: ResolvedCommand;
  try {
    resolvedCommand = resolveAttachedCommand(spec, ctx);
  } catch (err) {
    const detail = err instanceof CommandNotFoundError
      ? err.message
      : `failed to prepare command: ${(err as Error).message}`;
    ctx.logger.emit("step.attached-process.resolve-failed", { stepId: spec.id, detail });
    return {
      ok: false,
      error: detail,
      attachedProcess: { stoppedBy: "exit", escalated: false, detail },
    };
  }
  const expectsReady = spec.readyWhen.length > 0 || spec.verifyReady.length > 0;
  const registerName = spec.registerAs ?? ctx.planName;
  const controlDir = join(ctx.env.home, ".bankai", "state", "attached", registerName);
  const stopRequestFile = join(controlDir, "stop-request.json");
  const stopDoneFile = join(controlDir, "stop-done.json");
  if (spec.requireVisibleTerminal && !ctx.visibleAttachedTerminal) {
    const detail = "attached-process requires a visible terminal. Run bankai normally so it can open a visible terminal window.";
    ctx.logger.emit("step.attached-process.visible-terminal-required", {
      stepId: spec.id,
      detail,
    });
    return {
      ok: false,
      error: detail,
      attachedProcess: {
        stoppedBy: "exit",
        escalated: false,
        detail,
      },
    };
  }
  ctx.logger.emit("step.attached-process.spawn", {
    stepId: spec.id,
    command: resolvedCommand.command,
    args: resolvedCommand.args,
    requestedCommand: spec.command,
    resolvedCommand: resolvedCommand.detail,
    cwd: resolvedCwd,
    timeoutMs: spec.timeoutMs,
    stdio: spec.stdio,
  });

  return await new Promise<StepRunResult>((resolveRun) => {
    let settled = false;
    let interrupted = false;
    let ready = false;
    let readyInProgress = false;
    let startupTimer: NodeJS.Timeout | undefined;
    let pendingFailure: { error: string; detail: string } | undefined;
    let stopWatcher: FSWatcher | undefined;
    let stopPollTimer: NodeJS.Timeout | undefined;
    let registered = false;
    let registrationDone: Promise<void> = Promise.resolve();

    const cleanupStopWatching = (): void => {
      stopWatcher?.close();
      stopWatcher = undefined;
      if (stopPollTimer) {
        clearInterval(stopPollTimer);
        stopPollTimer = undefined;
      }
    };

    const settle = (result: StepRunResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (startupTimer) {
        clearTimeout(startupTimer);
      }
      cleanupStopWatching();
      ctx.signal.removeEventListener("abort", onAbort);
      void (async () => {
        await registrationDone;
        // registrationDone may have created watchers after settle ran synchronously
        // (fast-exit children race). Always close them here.
        cleanupStopWatching();
        if (registered && handle) {
          if (result.ok) {
            await ctx.registry.removeEntry(registerName);
          } else {
            await ctx.registry.putEntry({
              ...handle,
              name: registerName,
              planName: ctx.planName,
              planPath: ctx.planPath,
              cwd: resolvedCwd,
              registeredAt: ctx.env.clock.isoNow(),
              control: { stopRequestFile, stopDoneFile },
              evidence: {
                detail: result.error ?? result.attachedProcess?.detail ?? "attached process failed",
                lastResult: {
                  ok: false,
                  finishedAt: ctx.env.clock.isoNow(),
                  detail: result.error ?? result.attachedProcess?.detail ?? "attached process failed",
                  exitCode: result.attachedProcess?.exitCode,
                  signal: result.attachedProcess?.signal,
                },
              },
            });
          }
        }
        if (result.attachedProcess) {
          await mkdir(controlDir, { recursive: true }).catch(() => {});
          await writeFile(stopDoneFile, JSON.stringify({
            stoppedAt: ctx.env.clock.isoNow(),
            ok: result.ok,
            detail: result.attachedProcess.detail,
          }, null, 2) + "\n", "utf8").catch(() => {});
        }
        if (!result.ok && ctx.visibleReadyEventFile) {
          await mkdir(dirname(ctx.visibleReadyEventFile), { recursive: true }).catch(() => {});
          await writeFile(ctx.visibleReadyEventFile, JSON.stringify({
            event: "bankai.failed",
            ok: false,
            planName: ctx.planName,
            planPath: ctx.planPath,
            stepId: spec.id,
            failedAt: ctx.env.clock.isoNow(),
            detail: result.error ?? result.attachedProcess?.detail ?? "attached process failed",
          }, null, 2) + "\n", "utf8").catch(() => {});
        }
        resolveRun(result);
      })();
    };

    const child = spawn(resolvedCommand.command, resolvedCommand.args, {
      cwd: resolvedCwd,
      shell: false,
      windowsVerbatimArguments: resolvedCommand.windowsVerbatimArguments === true,
      windowsHide: false,
      stdio: spec.stdio === "inherit" ? "inherit" : ["inherit", "pipe", "pipe"],
      env: ctx.env.env as NodeJS.ProcessEnv,
    });
    const handle: ProcessHandle | undefined = child.pid
      ? {
        pid: child.pid,
        command: resolvedCommand.command,
        args: resolvedCommand.args,
        workDir: resolvedCwd,
        envKind: "attached-process",
        logFile: ctx.logger.logFilePath,
        logStartOffset: 0,
      }
      : undefined;

    registrationDone = (async () => {
      if (!handle) {
        return;
      }
      // Register the entry FIRST so a concurrent `bankai status` racing with
      // the child's own external readiness signal (e.g., the child writing a
      // file it controls) still sees the entry. mkdir + rm + watch follow.
      await ctx.registry.putEntry({
        ...handle,
        name: registerName,
        planName: ctx.planName,
        planPath: ctx.planPath,
        cwd: resolvedCwd,
        registeredAt: ctx.env.clock.isoNow(),
        control: { stopRequestFile, stopDoneFile },
      });
      registered = true;
      // Do NOT remove the entry here if `settled` became true. settle's IIFE
      // owns the ok-vs-failure entry lifecycle and would otherwise lose the
      // failure record for fast-exit children.
      if (settled) {
        return;
      }
      await mkdir(controlDir, { recursive: true });
      await Promise.all([
        rm(stopRequestFile, { force: true }),
        rm(stopDoneFile, { force: true }),
      ]);
      if (settled) {
        return;
      }
      const triggerStop = (): void => {
        if (existsSync(stopRequestFile)) {
          ctx.logger.emit("step.attached-process.stop-request", {
            stepId: spec.id,
            name: registerName,
            stopRequestFile,
          });
          onAbort();
        }
      };
      stopWatcher = watch(controlDir, triggerStop);
      // Poll fallback: fs.watch on Windows can silently miss the stop-request
      // create event on some FS/host combos. The relay script in
      // src/environments/managed-process.ts uses the same poll fallback for
      // the same reason.
      stopPollTimer = setInterval(triggerStop, 500);
      if (settled) {
        cleanupStopWatching();
        return;
      }
      // Race-safety: a stop request may have arrived between rm and watch.
      if (existsSync(stopRequestFile)) {
        triggerStop();
      }
      ctx.logger.emit("registry.put", { name: registerName, pid: handle.pid, envKind: "attached-process" });
    })().catch((err: unknown) => {
      failAndStop("attached process registration failed", err instanceof Error ? err.message : String(err));
    });

    const failAndStop = (error: string, detail: string): void => {
      if (settled || pendingFailure) {
        return;
      }
      pendingFailure = { error, detail };
      ctx.logger.emit("step.attached-process.fail", { stepId: spec.id, error, detail });
      if (child.pid) {
        child.kill("SIGTERM");
      } else {
        settle({
          ok: false,
          error,
          attachedProcess: {
            stoppedBy: "exit",
            escalated: false,
            detail,
          },
        });
      }
    };

    const publishMatchedReady = async (match: MatchedOutput): Promise<void> => {
      if (ready || readyInProgress || settled) {
        return;
      }
      readyInProgress = true;
      if (startupTimer) {
        clearTimeout(startupTimer);
        startupTimer = undefined;
      }
      let observations: ReadinessObservation[] = [];
      try {
        if (handle && spec.verifyReady.length > 0) {
          const verified = await evaluateReadiness({
            env: ctx.env,
            handle,
            signal: ctx.signal,
            refs: spec.verifyReady,
          });
          if (settled) {
            return;
          }
          observations = verified.observations;
          ctx.logger.emit("step.attached-process.ready-verify", {
            stepId: spec.id,
            allReady: verified.allReady,
            observations,
          });
          if (!verified.allReady) {
            failAndStop(
              `attached process readiness verification failed after output match "${match.id}"`,
              observations.map((o) => o.detail).join("; ") || "readiness verification failed",
            );
            return;
          }
        }
      } catch (err) {
        failAndStop(
          `attached process readiness verification failed after output match "${match.id}"`,
          err instanceof Error ? err.message : String(err),
        );
        return;
      }
      if (settled) {
        return;
      }
      ready = true;
      ctx.logger.emit("step.attached-process.ready", { stepId: spec.id, match });
      await publishReadyEvent(spec, ctx, match, observations);
    };

    const onOutputLine = (stream: "stdout" | "stderr", line: string): void => {
      ctx.logger.emit(`step.attached-process.${stream}`, { stepId: spec.id, line });
      const failure = findOutputMatch(spec.failWhen, stream, line);
      if (failure) {
        failAndStop(`attached process emitted failure output "${failure.id}"`, failure.line);
        return;
      }
      const match = findOutputMatch(spec.readyWhen, stream, line);
      if (match) {
        void publishMatchedReady(match);
      }
    };

    if (spec.stdio === "pipe") {
      if (child.stdout) {
        child.stdout.on("data", (chunk: Buffer) => process.stdout.write(chunk));
        createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => onOutputLine("stdout", line));
      }
      if (child.stderr) {
        child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
        createInterface({ input: child.stderr, crlfDelay: Infinity }).on("line", (line) => onOutputLine("stderr", line));
      }
    }

    if (expectsReady) {
      startupTimer = setTimeout(() => {
        failAndStop(
          `attached process did not become ready after ${spec.timeoutMs}ms`,
          "startup timeout elapsed before readyWhen matched and verifyReady passed",
        );
      }, spec.timeoutMs);
      if (spec.readyWhen.length === 0) {
        void publishMatchedReady({ id: "process-started", stream: "stdout", line: "process started" });
      }
    }

    const onAbort = (): void => {
      interrupted = true;
      ctx.logger.emit("step.attached-process.ctrl-c", {
        stepId: spec.id,
        pid: child.pid,
        detail: "forwarding Ctrl+C to the attached process and waiting for it to exit",
      });
      if (startupTimer) {
        clearTimeout(startupTimer);
        startupTimer = undefined;
      }
      if (child.pid) {
        child.kill("SIGINT");
      }
    };

    if (ctx.signal.aborted) {
      onAbort();
    } else {
      ctx.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (err) => {
      settle({
        ok: false,
        error: err.message,
        attachedProcess: {
          stoppedBy: interrupted ? "ctrl-c" : "exit",
          escalated: false,
          detail: err.message,
        },
      });
    });

    child.on("exit", (code, signal) => {
      const exitCode = code ?? undefined;
      const stoppedBy = interrupted ? "ctrl-c" : "exit";
      const exitedSuccessfully = exitCode !== undefined && spec.successExitCodes.includes(exitCode);
      const ok = !pendingFailure && (interrupted || (exitedSuccessfully && (!expectsReady || ready)));
      const detail = signal
        ? `attached process exited from signal ${signal}`
        : `attached process exited with code ${exitCode ?? "unknown"}`;
      const error = pendingFailure?.error
        ?? (ok ? undefined : expectsReady && !ready ? `attached process exited before readiness: ${detail}` : detail);
      settle({
        ok,
        error,
        attachedProcess: {
          exitCode,
          signal: signal ?? undefined,
          stoppedBy,
          escalated: false,
          detail: pendingFailure?.detail ?? detail,
        },
      });
    });
  });
}

async function publishReadyEvent(
  spec: AttachedProcessStepV1,
  ctx: StepContext,
  match: MatchedOutput,
  observations: ReadinessObservation[],
): Promise<void> {
  const event = {
    event: "bankai.ready",
    planName: ctx.planName,
    planPath: ctx.planPath,
    stepId: spec.id,
    match,
    observations,
    readyAt: ctx.env.clock.isoNow(),
  };
  ctx.logger.emit("bankai.ready", event);
  if (spec.readyEventFile) {
    const eventFile = resolveBindingPath(spec.readyEventFile, { workDir: ctx.workDir, bindings: ctx.bindings });
    await writeJsonAtomic(eventFile, event);
  }
  if (ctx.visibleReadyEventFile) {
    await writeJsonAtomic(ctx.visibleReadyEventFile, { ...event, ok: true });
  }
  if (spec.announceReady && !ctx.visibleReadyEventFile) {
    process.stdout.write(`BANKAI_READY ${JSON.stringify(event)}\n`);
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rm(path, { force: true });
  await import("node:fs/promises").then((fs) => fs.rename(tmp, path));
}

registerStep({
  kind: "attached-process",
  schema: AttachedProcessStepV1Schema,
  run: runAttachedProcess,
});
