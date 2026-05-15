import { z } from "zod";
import { spawn } from "node:child_process";
import { registerStep, type StepContext } from "./_registry.js";
import type { BankaiStepResult } from "../schema/envelope.js";

// Shell step kind: runs a single short-lived command and captures stdout,
// stderr, and exit code. Invariants the next editor must preserve:
//   1. shell must remain false. Anything that goes through cmd.exe or /bin/sh
//      introduces quoting bugs and lets unsanitized strings execute.
//   2. windowsHide must remain true so headless CI runs do not orphan windows.
//   3. command resolution is host-dependent. On Windows, plain "node" without
//      ".exe" may fail without shell:true. Scenarios should use absolute paths
//      or process.execPath when portability matters.
//   4. stdout and stderr are captured to memory. A future bytes-cap option
//      will exist but v1 trusts test scenarios to bound their own output.

export const ShellStepV1Schema = z.object({
  kind: z.literal("shell"),
  id: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().default(30000),
  expectExitCode: z.number().int().default(0),
});

export type ShellStepV1 = z.infer<typeof ShellStepV1Schema>;

async function runShell(
  spec: ShellStepV1,
  ctx: StepContext,
): Promise<Omit<BankaiStepResult, "id" | "kind">> {
  const start = ctx.env.clock.now();
  return await new Promise((resolve) => {
    let settled = false;
    const settle = (result: Omit<BankaiStepResult, "id" | "kind">): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd ?? ctx.workDir,
      shell: false,
      windowsHide: true,
      env: ctx.env.env as NodeJS.ProcessEnv,
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString("utf8");
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString("utf8");
      });
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({
        ok: false,
        durationMs: ctx.env.clock.now() - start,
        stdout: stdoutBuf,
        stderr: stderrBuf,
        error: `timed out after ${spec.timeoutMs}ms`,
      });
    }, spec.timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      settle({
        ok: false,
        durationMs: ctx.env.clock.now() - start,
        stdout: stdoutBuf,
        stderr: stderrBuf,
        error: err.message,
      });
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      const exitCode = code ?? -1;
      const ok = exitCode === spec.expectExitCode;
      settle({
        ok,
        durationMs: ctx.env.clock.now() - start,
        exitCode,
        stdout: stdoutBuf,
        stderr: stderrBuf,
        error: ok ? undefined : `expected exit code ${spec.expectExitCode}, got ${exitCode}`,
      });
    });
  });
}

registerStep({
  kind: "shell",
  schema: ShellStepV1Schema,
  run: runShell,
});
