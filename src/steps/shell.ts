import { z } from "zod";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { delimiter, join } from "node:path";
import { registerStep, type StepContext, type StepRunResult } from "./registry.js";
import { BindingPathRefSchema, resolveBindingPath } from "../bindings.js";
import type { Env } from "../env-runtime/env.js";

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

export const ShellStepV1Schema = z.object({
  kind: z.literal("shell"),
  id: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  resolveCommand: z.boolean().default(true),
  cwd: BindingPathRefSchema.optional(),
  timeoutMs: z.number().int().positive().default(30_000),
  expectExitCode: z.number().int().default(0),
  retries: z.number().int().min(0).max(5).default(0),
  maxBufferBytes: z.number().int().positive().default(DEFAULT_BUFFER_BYTES),
  /** Optional environment variables merged into the spawn env. NEVER persisted in step results or registry. */
  env: z.record(z.string(), z.string()).optional(),
  continueOnFail: z.boolean().optional(),
}).strict();

export type ShellStepV1 = z.infer<typeof ShellStepV1Schema>;

interface ResolvedShellCommand {
  command: string;
  args: string[];
  detail: string;
  windowsVerbatimArguments?: boolean;
}

function findOnPath(env: Env, command: string): string | undefined {
  if (command.includes("\\") || command.includes("/")) {
    return existsSync(command) ? command : undefined;
  }
  const pathVar = env.env.PATH ?? env.env.Path ?? "";
  const dirs = pathVar.split(delimiter).filter((dir) => dir.length > 0);
  const exts = env.platform === "win32"
    ? (env.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.toLowerCase())
    : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function quoteCmdArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function resolveShellCommand(spec: ShellStepV1, env: Env): ResolvedShellCommand {
  if (!spec.resolveCommand) {
    return { command: spec.command, args: spec.args, detail: spec.command };
  }
  const discovered = findOnPath(env, spec.command) ?? spec.command;
  if (env.platform === "win32" && discovered.toLowerCase().endsWith(".cmd") && existsSync(discovered)) {
    const cmd = env.env.ComSpec ?? env.env.COMSPEC ?? "cmd.exe";
    const commandLine = [quoteCmdArg(discovered), ...spec.args.map(quoteCmdArg)].join(" ");
    return {
      command: cmd,
      args: ["/d", "/s", "/c", `"${commandLine}"`],
      detail: `${cmd} /d /s /c "${commandLine}"`,
      windowsVerbatimArguments: true,
    };
  }
  return { command: discovered, args: spec.args, detail: discovered };
}

async function runShellAttempt(spec: ShellStepV1, ctx: StepContext, resolvedCwd: string, attempt: number): Promise<StepRunResult> {
  const resolvedCommand = resolveShellCommand(spec, ctx.env);
  ctx.logger.emit("step.shell.spawn", {
    stepId: spec.id,
    command: resolvedCommand.command,
    args: resolvedCommand.args,
    requestedCommand: spec.command,
    resolvedCommand: resolvedCommand.detail,
    cwd: resolvedCwd,
    timeoutMs: spec.timeoutMs,
    expectExitCode: spec.expectExitCode,
    attempt,
  });

  return await new Promise<StepRunResult>((resolveRun) => {
    let settled = false;
    const settle = (r: StepRunResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolveRun(r);
    };

    const child = spawn(resolvedCommand.command, resolvedCommand.args, {
      cwd: resolvedCwd,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: resolvedCommand.windowsVerbatimArguments,
      env: spec.env ? { ...ctx.env.env, ...spec.env } : (ctx.env.env as NodeJS.ProcessEnv),
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
      rl.on("line", (line) => {
        stdoutBytes += Buffer.byteLength(line, "utf8") + 1;
        if (stdoutBuf.length < spec.maxBufferBytes) {
          stdoutBuf += line + "\n";
          if (stdoutBuf.length > spec.maxBufferBytes) {
            stdoutBuf = stdoutBuf.slice(0, spec.maxBufferBytes);
          }
        }
        ctx.logger.emit("step.shell.stdout", { stepId: spec.id, line });
      });
    }
    if (child.stderr) {
      const rl = createInterface({ input: child.stderr, crlfDelay: Infinity });
      rl.on("line", (line) => {
        stderrBytes += Buffer.byteLength(line, "utf8") + 1;
        if (stderrBuf.length < spec.maxBufferBytes) {
          stderrBuf += line + "\n";
          if (stderrBuf.length > spec.maxBufferBytes) {
            stderrBuf = stderrBuf.slice(0, spec.maxBufferBytes);
          }
        }
        ctx.logger.emit("step.shell.stderr", { stepId: spec.id, line });
      });
    }

    const onAbort = (): void => {
      child.kill("SIGKILL");
    };
    if (ctx.signal.aborted) {
      onAbort();
    } else {
      ctx.signal.addEventListener("abort", onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({
        ok: false,
        error: `attempt ${attempt} timed out after ${spec.timeoutMs}ms`,
        shell: {
          stdout: stdoutBuf,
          stderr: stderrBuf,
          stdoutBytes,
          stderrBytes,
        },
      });
    }, spec.timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      settle({
        ok: false,
        error: `attempt ${attempt} failed to spawn: ${err.message}`,
        shell: {
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
      const exitCode = code ?? -1;
      const ok = exitCode === spec.expectExitCode;
      settle({
        ok,
        error: ok ? undefined : `attempt ${attempt} expected exit code ${spec.expectExitCode}, got ${exitCode}`,
        shell: {
          exitCode,
          stdout: stdoutBuf,
          stderr: stderrBuf,
          stdoutBytes,
          stderrBytes,
        },
      });
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
