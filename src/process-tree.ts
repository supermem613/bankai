import { spawn } from "node:child_process";
import type { Env } from "./env-runtime/env.js";

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

async function runProbe(env: Env, command: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: env.env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });
}

function collectDescendants(root: number, rows: Array<{ pid: number; ppid: number }>): number[] {
  const children = new Map<number, number[]>();
  for (const row of rows) {
    const list = children.get(row.ppid) ?? [];
    list.push(row.pid);
    children.set(row.ppid, list);
  }
  const result: number[] = [];
  const stack = [root];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    result.push(pid);
    for (const child of children.get(pid) ?? []) {
      stack.push(child);
    }
  }
  return result;
}

async function queryWindowsProcessTree(opts: { pid: number; env: Env }): Promise<number[]> {
  const ps = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress";
  try {
    const result = await runProbe(opts.env, "powershell.exe", ["-NoProfile", "-NoLogo", "-NonInteractive", "-Command", ps]);
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      return [opts.pid];
    }
    const parsed = JSON.parse(result.stdout) as Array<{ ProcessId: number; ParentProcessId: number }> | { ProcessId: number; ParentProcessId: number };
    const rows = (Array.isArray(parsed) ? parsed : [parsed])
      .map((row) => ({ pid: row.ProcessId, ppid: row.ParentProcessId }))
      .filter((row) => Number.isFinite(row.pid) && Number.isFinite(row.ppid));
    return collectDescendants(opts.pid, rows);
  } catch {
    return [opts.pid];
  }
}

export async function listProcessTreePids(opts: { pid: number; env: Env }): Promise<number[]> {
  if (!isProcessAlive(opts.pid)) {
    return [];
  }
  if (opts.env.platform === "win32") {
    const first = await queryWindowsProcessTree(opts);
    // WMI Win32_Process is cache-backed and can lag behind recent process
    // creations on Windows. When the first snapshot lists only the root pid,
    // retry once after a brief delay so descendants spawned shortly before
    // the call are visible. If the root has genuinely no children, this
    // costs ~150ms once per call. The alternative (silently missing
    // children) leaks orphaned processes after stop.
    if (first.length <= 1 && isProcessAlive(opts.pid)) {
      await delay(150);
      if (!isProcessAlive(opts.pid)) {
        return first;
      }
      const second = await queryWindowsProcessTree(opts);
      return second.length > first.length ? second : first;
    }
    return first;
  }
  try {
    const result = await runProbe(opts.env, "ps", ["-eo", "pid=,ppid="]);
    if (result.exitCode !== 0) {
      return [opts.pid];
    }
    const rows = result.stdout.split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter((parts) => parts.length === 2 && parts.every(Number.isFinite))
      .map(([pid, ppid]) => ({ pid, ppid }));
    return collectDescendants(opts.pid, rows);
  } catch {
    return [opts.pid];
  }
}

// Re-snapshot the process tree without requiring the root pid to still be
// alive. Used after an attached process has exited to catch orphaned
// grandchildren whose ParentProcessId still points at the (now-dead) root.
// Windows preserves the original PPID even after the parent dies, so the
// descendant walk still resolves them. POSIX `ps` likewise reports the
// stored ppid (which becomes 1 once init re-parents); we only call this
// before re-parenting completes, so descendants are still discoverable.
export async function listProcessTreePidsIncludingOrphans(opts: { pid: number; env: Env }): Promise<number[]> {
  if (opts.env.platform === "win32") {
    return queryWindowsProcessTree(opts);
  }
  try {
    const result = await runProbe(opts.env, "ps", ["-eo", "pid=,ppid="]);
    if (result.exitCode !== 0) {
      return [];
    }
    const rows = result.stdout.split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter((parts) => parts.length === 2 && parts.every(Number.isFinite))
      .map(([pid, ppid]) => ({ pid, ppid }));
    return collectDescendants(opts.pid, rows);
  } catch {
    return [];
  }
}

export async function waitForPidsExit(pids: number[], timeoutMs: number, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const unique = [...new Set(pids)];
  while (Date.now() < deadline) {
    if (unique.every((pid) => !isProcessAlive(pid))) {
      return true;
    }
    await delay(pollIntervalMs);
  }
  return unique.every((pid) => !isProcessAlive(pid));
}

export async function terminateProcessTrees(opts: { pids: number[]; graceMs: number; env: Env }): Promise<TerminateResult> {
  const unique = [...new Set(opts.pids)].filter(isProcessAlive);
  if (unique.length === 0) {
    return { killed: true, escalated: false, detail: "all tracked pids were already gone" };
  }
  if (opts.env.platform !== "win32") {
    for (const pid of unique) {
      try {
        process.kill(pid, "SIGTERM");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ESRCH" && code !== "EPERM") {
          throw err;
        }
      }
    }
    if (await waitForPidsExit(unique, opts.graceMs)) {
      return { killed: true, escalated: false, detail: `SIGTERM succeeded for tracked pids: ${unique.join(", ")}` };
    }
    for (const pid of unique.filter(isProcessAlive)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ESRCH" && code !== "EPERM") {
          throw err;
        }
      }
    }
    const killed = await waitForPidsExit(unique, Math.max(opts.graceMs, 2000));
    return {
      killed,
      escalated: true,
      detail: killed
        ? `SIGKILL succeeded for tracked pids: ${unique.join(", ")}`
        : `SIGKILL failed for tracked pids: ${unique.filter(isProcessAlive).join(", ")}`,
    };
  }
  const results: TerminateResult[] = [];
  for (const pid of unique) {
    results.push(await terminateProcessTree({ pid, graceMs: opts.graceMs, env: opts.env }));
  }
  const killed = unique.every((pid) => !isProcessAlive(pid));
  return {
    killed,
    escalated: results.some((r) => r.escalated),
    detail: killed
      ? `terminated lingering process trees: ${unique.join(", ")}`
      : `failed to terminate lingering pids: ${unique.filter(isProcessAlive).join(", ")}`,
  };
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
