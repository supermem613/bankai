import { z } from "zod";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve as resolvePath, isAbsolute as isAbsolutePath } from "node:path";
import { registerStep, type StepContext, type StepRunResult } from "./registry.js";

// shell step kind: spawn a single short-lived command, capture stdout
// and stderr to memory and stream them line-by-line into the JSONL
// run log, and assert exit code matches expectExitCode.
//
// Invariants the next editor must preserve:
//   1. shell:false. Anything that goes through cmd.exe or /bin/sh
//      introduces quoting bugs and lets unsanitized strings execute.
//   2. windowsHide:true. Headless CI runs must not orphan windows.
//   3. command resolution is host-dependent. On Windows, plain "node"
//      without ".exe" may fail without shell:true. Plans should use
//      absolute paths or process.execPath when portability matters.
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
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().default(30_000),
  expectExitCode: z.number().int().default(0),
  maxBufferBytes: z.number().int().positive().default(DEFAULT_BUFFER_BYTES),
  /** Optional environment variables merged into the spawn env. NEVER persisted in step results or registry. */
  env: z.record(z.string(), z.string()).optional(),
  continueOnFail: z.boolean().optional(),
});

export type ShellStepV1 = z.infer<typeof ShellStepV1Schema>;

async function runShell(spec: ShellStepV1, ctx: StepContext): Promise<StepRunResult> {
  const resolvedCwd = spec.cwd
    ? isAbsolutePath(spec.cwd)
      ? spec.cwd
      : resolvePath(ctx.workDir, spec.cwd)
    : ctx.workDir;

  ctx.logger.emit("step.shell.spawn", {
    stepId: spec.id,
    command: spec.command,
    args: spec.args,
    cwd: resolvedCwd,
    timeoutMs: spec.timeoutMs,
    expectExitCode: spec.expectExitCode,
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

    const child = spawn(spec.command, spec.args, {
      cwd: resolvedCwd,
      shell: false,
      windowsHide: true,
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
        error: `timed out after ${spec.timeoutMs}ms`,
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
        error: err.message,
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
        error: ok ? undefined : `expected exit code ${spec.expectExitCode}, got ${exitCode}`,
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

registerStep({
  kind: "shell",
  schema: ShellStepV1Schema,
  run: runShell,
});
