import { z } from "zod";
import { spawn } from "node:child_process";
import { createWriteStream, readFileSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { registerStep, type StepContext, type StepRunResult } from "./registry.js";
import { BindingConditionSchema, BindingPathRefSchema, BindingValueRefSchema, evaluateBindingCondition, interpolateBindings, resolveBindingPath, resolveBindingValueRef } from "../bindings.js";
import type { Env } from "../env-runtime/env.js";
import { terminateProcessTree } from "../process-tree.js";
import { CommandNotFoundError, resolveCommand } from "../spawn/resolve-command.js";

// shell step kind: spawn a single short-lived command, capture stdout
// and stderr to memory and stream them line-by-line into the JSONL
// run log, and assert exit code matches expectExitCode.
//
// Invariants the next editor must preserve:
//   1. shell:false. Anything that goes through cmd.exe or /bin/sh
//      introduces quoting bugs and lets unsanitized strings execute.
//   2. windowsHide:true. Headless CI runs must not orphan windows.
//   3. command resolution preserves Windows .cmd shims through cmd.exe.
//      This lets plans invoke PATH tools without hardcoding JS entrypoints.
//   4. spec.cwd is interpreted relative to ctx.workDir when relative.
//      ctx.workDir is the resolved repoRoot for the run, NOT
//      process.cwd, so bankai produces stable behavior regardless of
//      where the user invoked it from.
//   5. stdout and stderr are captured to bounded buffers and ALSO
//      streamed line-by-line into the JSONL log via step.output.line
//      events. The buffers cap at maxBufferBytes per stream so a
//      runaway process cannot OOM bankai. The full stream lives in
//      the JSONL log lines.
//   6. The step result reports byte counts and a tail of each stream
//      for human envelopes; the JSONL log carries the full content.

const DEFAULT_BUFFER_BYTES = 1_048_576;
const DEFAULT_ARG_FILE_BYTES = 1_048_576;
const SHELL_TERMINATE_GRACE_MS = 2_000;
const MAX_LOG_LINE_CHARS = 16_384;

const ShellArgFileTextSchema = z.object({
  fileText: BindingPathRefSchema,
}).strict();

const ShellArgSchema = z.union([z.string(), z.number(), z.boolean(), ShellArgFileTextSchema, BindingValueRefSchema]);

const ShellArgGroupSchema = z.object({
  id: z.string().min(1).optional(),
  skipIfAbsent: z.string().min(1),
  args: z.array(ShellArgSchema).min(1),
}).strict();

const ShellArgOrGroupSchema = z.union([ShellArgSchema, ShellArgGroupSchema]);

export const ShellStepV1Schema = z.object({
  kind: z.literal("shell"),
  id: z.string().min(1),
  command: z.string().min(1),
  args: z.array(ShellArgOrGroupSchema).default([]),
  resolveCommand: z.boolean().default(true),
  cwd: BindingPathRefSchema.optional(),
  stdoutFile: BindingPathRefSchema.optional(),
  timeoutMs: z.number().int().positive().default(30_000),
  expectExitCode: z.number().int().default(0),
  retries: z.number().int().min(0).max(5).default(0),
  maxBufferBytes: z.number().int().positive().default(DEFAULT_BUFFER_BYTES),
  /** Optional environment variables merged into the spawn env. NEVER persisted in step results or registry. */
  env: z.record(z.string(), z.string()).optional(),
  continueOnFail: z.boolean().optional(),
  alwaysRun: z.boolean().optional(),
  runIf: BindingConditionSchema.optional(),
  skipIf: BindingConditionSchema.optional(),
}).strict();

export type ShellStepV1 = z.infer<typeof ShellStepV1Schema>;

interface ResolvedShellCommand {
  command: string;
  args: string[];
  detail: string;
  windowsVerbatimArguments?: boolean;
}

function resolveShellArg(arg: z.infer<typeof ShellArgSchema>, ctx: StepContext): string {
  if (typeof arg === "object") {
    if ("fileText" in arg) {
      const file = resolveBindingPath(arg.fileText, { workDir: ctx.workDir, bindings: ctx.bindings });
      const size = statSync(file).size;
      if (size > DEFAULT_ARG_FILE_BYTES) {
        throw new Error(`arg file "${file}" exceeds ${DEFAULT_ARG_FILE_BYTES} bytes`);
      }
      return readFileSync(file, "utf8");
    }
    return resolveBindingValueRef(arg, { workDir: ctx.workDir, bindings: ctx.bindings });
  }
  return typeof arg === "string" ? interpolateBindings(arg, { bindings: ctx.bindings }) : String(arg);
}

function resolveShellArgs(spec: ShellStepV1, ctx: StepContext): string[] {
  return spec.args.flatMap((arg) => {
    if (typeof arg === "object") {
      if ("skipIfAbsent" in arg) {
        const condition = evaluateBindingCondition({ binding: arg.skipIfAbsent, present: false }, { bindings: ctx.bindings });
        if (condition.matches) {
          ctx.logger.emit("step.shell.arg-group.omitted", {
            stepId: spec.id,
            groupId: arg.id,
            binding: arg.skipIfAbsent,
            reason: "binding absent",
          });
          return [];
        }
        return arg.args.map((groupArg) => resolveShellArg(groupArg, ctx));
      }
    }
    return [resolveShellArg(arg, ctx)];
  });
}

export function resolveShellCommand(spec: ShellStepV1, env: Env, args: string[] = spec.args.map(String)): ResolvedShellCommand {
  if (!spec.resolveCommand) {
    return { command: spec.command, args, detail: spec.command };
  }
  const r = resolveCommand(spec.command, args, env);
  return {
    command: r.command,
    args: r.args,
    detail: r.detail,
    windowsVerbatimArguments: r.windowsVerbatimArguments,
  };
}

async function runShellAttempt(spec: ShellStepV1, ctx: StepContext, resolvedCwd: string, attempt: number): Promise<StepRunResult> {
  let resolvedCommand: ResolvedShellCommand;
  try {
    resolvedCommand = resolveShellCommand(spec, ctx.env, resolveShellArgs(spec, ctx));
  } catch (err) {
    const isMissing = err instanceof CommandNotFoundError;
    return {
      ok: false,
      error: `attempt ${attempt} failed to ${isMissing ? "resolve" : "prepare"} command: ${(err as Error).message}`,
      shell: { stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0 },
    };
  }
  const stdoutFile = spec.stdoutFile
    ? resolveBindingPath(spec.stdoutFile, { workDir: ctx.workDir, bindings: ctx.bindings })
    : undefined;
  if (stdoutFile) {
    await mkdir(dirname(stdoutFile), { recursive: true });
  }
  ctx.logger.emit("step.shell.spawn", {
    stepId: spec.id,
    command: resolvedCommand.command,
    args: resolvedCommand.args,
    requestedCommand: spec.command,
    resolvedCommand: resolvedCommand.detail,
    cwd: resolvedCwd,
    stdoutFile,
    timeoutMs: spec.timeoutMs,
    expectExitCode: spec.expectExitCode,
    attempt,
  });

  return await new Promise<StepRunResult>((resolveRun) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let terminateDetail = "";
    const settle = (r: StepRunResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolveRun(r);
    };

    const child = spawn(resolvedCommand.command, resolvedCommand.args, {
      cwd: resolvedCwd,
      detached: ctx.env.platform !== "win32",
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: resolvedCommand.windowsVerbatimArguments,
      env: spec.env ? { ...ctx.env.env, ...spec.env } : (ctx.env.env as NodeJS.ProcessEnv),
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let pendingStdoutLine = "";
    let pendingStderrLine = "";
    let stdoutFileError: string | undefined;
    const stdoutFileStream = stdoutFile ? createWriteStream(stdoutFile, { encoding: "utf8" }) : undefined;
    stdoutFileStream?.on("error", (err) => {
      stdoutFileError = err.message;
    });

    const appendBounded = (current: string, text: string): string => {
      if (current.length >= spec.maxBufferBytes) {
        return current;
      }
      const next = current + text;
      return next.length > spec.maxBufferBytes ? next.slice(0, spec.maxBufferBytes) : next;
    };
    const emitStreamLines = (stream: "stdout" | "stderr", pending: string, text: string): string => {
      let next = pending + text;
      let newline = next.indexOf("\n");
      while (newline !== -1) {
        const rawLine = next.slice(0, newline);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        ctx.logger.emit(`step.shell.${stream}`, { stepId: spec.id, line });
        next = next.slice(newline + 1);
        newline = next.indexOf("\n");
      }
      while (next.length > MAX_LOG_LINE_CHARS) {
        ctx.logger.emit(`step.shell.${stream}`, {
          stepId: spec.id,
          line: next.slice(0, MAX_LOG_LINE_CHARS),
          partial: true,
        });
        next = next.slice(MAX_LOG_LINE_CHARS);
      }
      return next;
    };
    const flushPendingLine = (stream: "stdout" | "stderr", pending: string): void => {
      if (pending.length === 0) {
        return;
      }
      ctx.logger.emit(`step.shell.${stream}`, { stepId: spec.id, line: pending });
    };

    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer | string) => {
        stdoutFileStream?.write(chunk);
        const text = chunk.toString();
        stdoutBytes += Buffer.byteLength(text, "utf8");
        stdoutBuf = appendBounded(stdoutBuf, text);
        pendingStdoutLine = emitStreamLines("stdout", pendingStdoutLine, text);
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer | string) => {
        const text = chunk.toString();
        stderrBytes += Buffer.byteLength(text, "utf8");
        stderrBuf = appendBounded(stderrBuf, text);
        pendingStderrLine = emitStreamLines("stderr", pendingStderrLine, text);
      });
    }

    const closeCapturedStreams = (): void => {
      flushPendingLine("stdout", pendingStdoutLine);
      flushPendingLine("stderr", pendingStderrLine);
      pendingStdoutLine = "";
      pendingStderrLine = "";
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.stdout?.destroy();
      child.stderr?.destroy();
    };

    const terminateChildTree = async (): Promise<string> => {
      if (child.pid === undefined) {
        child.kill("SIGKILL");
        return "spawned process had no pid";
      }
      const result = await terminateProcessTree({
        pid: child.pid,
        graceMs: SHELL_TERMINATE_GRACE_MS,
        env: ctx.env,
      });
      return result.detail;
    };

    const onAbort = (): void => {
      aborted = true;
      void terminateChildTree().then((detail) => {
        terminateDetail = detail;
        stdoutFileStream?.end();
        settle({
          ok: false,
          error: `attempt ${attempt} aborted: ${detail}`,
          shell: {
            stdoutFile,
            stdout: stdoutBuf,
            stderr: stderrBuf,
            stdoutBytes,
            stderrBytes,
          },
        });
      }, (err: unknown) => {
        stdoutFileStream?.end();
        settle({
          ok: false,
          error: `attempt ${attempt} aborted and failed to terminate process tree: ${(err as Error).message}`,
          shell: {
            stdoutFile,
            stdout: stdoutBuf,
            stderr: stderrBuf,
            stdoutBytes,
            stderrBytes,
          },
        });
      });
    };
    if (ctx.signal.aborted) {
      onAbort();
    } else {
      ctx.signal.addEventListener("abort", onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      // Mark BEFORE awaiting terminateChildTree. The kill may cause the
      // child's exit handler to fire first; it must see `timedOut` and
      // report the timeout instead of the exit-code-mismatch message.
      timedOut = true;
      void terminateChildTree().then((detail) => {
        terminateDetail = detail;
        stdoutFileStream?.end();
        settle({
          ok: false,
          error: `attempt ${attempt} timed out after ${spec.timeoutMs}ms: ${detail}`,
          shell: {
            stdoutFile,
            stdout: stdoutBuf,
            stderr: stderrBuf,
            stdoutBytes,
            stderrBytes,
          },
        });
      }, (err: unknown) => {
        stdoutFileStream?.end();
        settle({
          ok: false,
          error: `attempt ${attempt} timed out after ${spec.timeoutMs}ms and failed to terminate process tree: ${(err as Error).message}`,
          shell: {
            stdoutFile,
            stdout: stdoutBuf,
            stderr: stderrBuf,
            stdoutBytes,
            stderrBytes,
          },
        });
      });
    }, spec.timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      stdoutFileStream?.end();
      settle({
        ok: false,
        error: `attempt ${attempt} failed to spawn: ${err.message}`,
        shell: {
          stdoutFile,
          stdout: stdoutBuf,
          stderr: stderrBuf,
          stdoutBytes,
          stderrBytes,
        },
      });
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      closeCapturedStreams();
      const exitCode = code ?? -1;
      const finishResult = (): void => {
        // When timed out or aborted, the timer/abort handler owns the error
        // message. The exit handler must not report a misleading
        // exit-code-mismatch error when the process was forcibly killed.
        if (timedOut) {
          settle({
            ok: false,
            error: `attempt ${attempt} timed out after ${spec.timeoutMs}ms${terminateDetail ? `: ${terminateDetail}` : ""}`,
            shell: {
              exitCode,
              stdoutFile,
              stdout: stdoutBuf,
              stderr: stderrBuf,
              stdoutBytes,
              stderrBytes,
            },
          });
          return;
        }
        if (aborted) {
          settle({
            ok: false,
            error: `attempt ${attempt} aborted${terminateDetail ? `: ${terminateDetail}` : ""}`,
            shell: {
              exitCode,
              stdoutFile,
              stdout: stdoutBuf,
              stderr: stderrBuf,
              stdoutBytes,
              stderrBytes,
            },
          });
          return;
        }
        const exitOk = exitCode === spec.expectExitCode;
        const ok = exitOk && stdoutFileError === undefined;
        settle({
          ok,
          error: stdoutFileError
            ? `attempt ${attempt} failed to write stdoutFile: ${stdoutFileError}`
            : (exitOk ? undefined : `attempt ${attempt} expected exit code ${spec.expectExitCode}, got ${exitCode}`),
          shell: {
            exitCode,
            stdoutFile,
            stdout: stdoutBuf,
            stderr: stderrBuf,
            stdoutBytes,
            stderrBytes,
          },
        });
      };
      if (stdoutFileStream) {
        stdoutFileStream.end(finishResult);
      } else {
        finishResult();
      }
    });
  });
}

async function runShell(spec: ShellStepV1, ctx: StepContext): Promise<StepRunResult> {
  const resolvedCwd = resolveBindingPath(spec.cwd, { workDir: ctx.workDir, bindings: ctx.bindings });
  const totalAttempts = spec.retries + 1;
  let lastResult: StepRunResult | undefined;
  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    if (ctx.signal.aborted) {
      break;
    }
    lastResult = await runShellAttempt(spec, ctx, resolvedCwd, attempt);
    if (lastResult.ok || attempt === totalAttempts) {
      return lastResult;
    }
    ctx.logger.emit("step.shell.retry", {
      stepId: spec.id,
      attempt,
      nextAttempt: attempt + 1,
      error: lastResult.error,
    });
  }
  return lastResult ?? { ok: false, error: "shell step aborted before it started" };
}

registerStep({
  kind: "shell",
  schema: ShellStepV1Schema,
  run: runShell,
});
