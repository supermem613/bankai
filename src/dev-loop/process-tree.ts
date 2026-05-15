import { spawn } from "node:child_process";
import type { Env } from "../env-runtime/env.js";

// Cross-platform process tree termination. INVARIANT: this MUST kill the
// entire spawned subtree, not just the leader. A dev server typically
// spawns watchers, workers, or compilers as children. Killing only the
// leader leaves zombies that hold ports and confuse the next start.
//
// Platform contracts:
//   * Windows: spawn taskkill.exe with /T /PID <pid> for the graceful
//     attempt, then escalate to /T /F /PID <pid>. /T means "tree". The
//     /F flag forces unconditional termination. taskkill is shipped with
//     every supported Windows host.
//   * POSIX: the long-lived child MUST have been spawned with
//     detached:true so it leads its own process group with PGID == PID.
//     We then signal the whole group via process.kill(-pid, signal). If
//     the child was NOT detached, -pid would target our own process
//     group and would kill bankai itself. The managed-process plugin in
//     src/environments/managed-process.ts owns this spawn contract.
//
// Liveness checks use process.kill(pid, 0). EPERM is treated as alive
// because it means the process exists but we lack permission to signal.
// Only ESRCH proves the process is gone.

export interface TerminateOptions {
  pid: number;
  graceMs: number;
  env: Env;
  pollIntervalMs?: number;
}

export interface TerminateResult {
  killed: boolean;
  escalated: boolean;
  detail: string;
}

const DEFAULT_POLL_INTERVAL_MS = 100;

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") {
      return true;
    }
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForExit(pid: number, timeoutMs: number, pollIntervalMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await delay(pollIntervalMs);
  }
  return !isProcessAlive(pid);
}

async function runTaskkill(env: Env, args: string[]): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("taskkill.exe", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: env.env,
      windowsHide: true,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ exitCode: code ?? -1, stderr }));
  });
}

export async function terminateProcessTree(opts: TerminateOptions): Promise<TerminateResult> {
  const { pid, graceMs, env } = opts;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  if (!isProcessAlive(pid)) {
    return { killed: true, escalated: false, detail: `pid ${pid} was not alive` };
  }

  if (env.platform === "win32") {
    let stderrSummary = "";
    try {
      const r = await runTaskkill(env, ["/T", "/PID", String(pid)]);
      stderrSummary = r.stderr;
    } catch (err) {
      stderrSummary = `graceful taskkill spawn error: ${(err as Error).message}`;
    }
    if (await waitForExit(pid, graceMs, pollIntervalMs)) {
      return { killed: true, escalated: false, detail: "taskkill /T succeeded" };
    }
    let escalateErr = "";
    try {
      const r2 = await runTaskkill(env, ["/T", "/F", "/PID", String(pid)]);
      escalateErr = r2.stderr;
    } catch (err) {
      escalateErr = `forceful taskkill spawn error: ${(err as Error).message}`;
    }
    const exitedAfterForce = await waitForExit(pid, Math.max(graceMs, 2000), pollIntervalMs);
    return {
      killed: exitedAfterForce,
      escalated: true,
      detail: exitedAfterForce
        ? "taskkill /T /F succeeded"
        : `taskkill /T /F failed; pid ${pid} still alive. graceful stderr: ${stderrSummary}; forceful stderr: ${escalateErr}`,
    };
  }

  // POSIX: signal the negative pid to reach the whole group.
  try {
    process.kill(-pid, "SIGTERM");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return { killed: true, escalated: false, detail: `process group -${pid} already gone` };
    }
    if (code !== "EPERM") {
      throw err;
    }
  }
  if (await waitForExit(pid, graceMs, pollIntervalMs)) {
    return { killed: true, escalated: false, detail: "SIGTERM to process group succeeded" };
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return { killed: true, escalated: true, detail: "process group disappeared between SIGTERM and SIGKILL" };
    }
    if (code !== "EPERM") {
      throw err;
    }
  }
  const exitedAfterKill = await waitForExit(pid, Math.max(graceMs, 2000), pollIntervalMs);
  return {
    killed: exitedAfterKill,
    escalated: true,
    detail: exitedAfterKill
      ? "SIGKILL to process group succeeded"
      : `SIGKILL sent but pid ${pid} still alive after grace`,
  };
}
