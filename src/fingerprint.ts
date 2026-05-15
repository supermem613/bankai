import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { Env } from "./env-runtime/env.js";
import type { ProcessFingerprint } from "./registry/types.js";
import { isProcessAlive } from "./process-tree.js";

// PID reuse fingerprinting. After a host reboots or a busy machine wraps
// its PID space, the pid we persisted at start could belong to a totally
// unrelated process by the time stop or status is called. Acting on a
// reused pid would kill an innocent program. To defuse this we capture
// two OS-sourced facts at start and re-capture before any destructive
// action, then refuse to act if the facts disagree.
//
// Captured facts:
//   * creationTime: when the kernel created the process. This changes
//     after a reboot or after the pid is reused for another command.
//   * commandLine: the process's command line as the kernel records it.
//     This is a sanity check on top of creationTime in case the OS clock
//     has low resolution.
//
// Per platform sources:
//   * Linux: /proc/<pid>/stat field 22 is start time in jiffies since
//     boot. Field 2 (in parentheses, possibly with spaces inside) is the
//     comm. Full cmdline lives in /proc/<pid>/cmdline.
//   * macOS: ps -o lstart=,command= -p <pid>.
//   * Windows: Get-CimInstance Win32_Process -Filter "ProcessId=<pid>"
//     exposes CreationDate and CommandLine.
//
// If we cannot read either fact for a platform we return undefined and
// the caller treats fingerprint comparison as a soft skip. Refusing to
// stop just because we cannot fingerprint would be worse than not
// fingerprinting at all.

export interface FingerprintOptions {
  pid: number;
  env: Env;
  timeoutMs?: number;
}

export interface VerifyResult {
  alive: boolean;
  matches: boolean;
  detail: string;
  current?: ProcessFingerprint;
}

const DEFAULT_TIMEOUT_MS = 5000;

async function runProbe(
  env: Env,
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: env.env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`fingerprint probe ${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

async function captureLinux(pid: number): Promise<ProcessFingerprint | undefined> {
  let stat: string;
  try {
    stat = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch {
    return undefined;
  }
  // Field 22 is starttime. The comm in field 2 can contain spaces and
  // parentheses, so we slice from the LAST close-paren and split the
  // rest.
  const closeParen = stat.lastIndexOf(")");
  if (closeParen < 0) {
    return undefined;
  }
  const after = stat.slice(closeParen + 1).trim().split(/\s+/);
  // After the comm field there are state(1), ppid(2), ..., starttime is
  // field 22 of the original list which means index 19 in the slice
  // after the comm (since we removed pid+comm = 2 fields).
  const startTime = after[19];
  if (!startTime) {
    return undefined;
  }
  let cmdline = "";
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`, "utf8");
    cmdline = raw.replace(/\0+$/, "").replace(/\0/g, " ");
  } catch {
    cmdline = "";
  }
  return {
    creationTime: `linux-jiffies:${startTime}`,
    commandLine: cmdline,
  };
}

async function captureMac(pid: number, env: Env, timeoutMs: number): Promise<ProcessFingerprint | undefined> {
  try {
    const r = await runProbe(env, "ps", ["-o", "lstart=,command=", "-p", String(pid)], timeoutMs);
    if (r.exitCode !== 0) {
      return undefined;
    }
    const trimmed = r.stdout.trim();
    if (!trimmed) {
      return undefined;
    }
    // ps lstart format is fixed-width 24 chars (e.g. "Mon Jan  2 15:04:05 2006").
    const lstart = trimmed.slice(0, 24).trim();
    const command = trimmed.slice(24).trim();
    if (!lstart) {
      return undefined;
    }
    return {
      creationTime: `mac-lstart:${lstart}`,
      commandLine: command,
    };
  } catch {
    return undefined;
  }
}

async function captureWindows(
  pid: number,
  env: Env,
  timeoutMs: number,
): Promise<ProcessFingerprint | undefined> {
  // We use PowerShell's Get-CimInstance to get a stable two-field shape.
  // ConvertTo-Json on a single object emits a JSON object, not an array.
  const ps =
    `$ErrorActionPreference='Stop';` +
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}";` +
    `if (-not $p) { exit 2 };` +
    `$obj = @{ creation = $p.CreationDate.ToUniversalTime().ToString('o'); cmd = ($p.CommandLine -as [string]) };` +
    `$obj | ConvertTo-Json -Compress`;
  let result: { stdout: string; stderr: string; exitCode: number };
  try {
    result = await runProbe(
      env,
      "powershell.exe",
      ["-NoProfile", "-NoLogo", "-NonInteractive", "-Command", ps],
      timeoutMs,
    );
  } catch {
    return undefined;
  }
  if (result.exitCode !== 0) {
    return undefined;
  }
  let parsed: { creation?: string; cmd?: string } | undefined;
  try {
    parsed = JSON.parse(result.stdout) as { creation?: string; cmd?: string };
  } catch {
    return undefined;
  }
  if (!parsed?.creation) {
    return undefined;
  }
  return {
    creationTime: `win-creation:${parsed.creation}`,
    commandLine: parsed.cmd ?? "",
  };
}

export async function captureFingerprint(opts: FingerprintOptions): Promise<ProcessFingerprint | undefined> {
  const { pid, env } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!isProcessAlive(pid)) {
    return undefined;
  }
  switch (env.platform) {
    case "linux":
      return captureLinux(pid);
    case "darwin":
      return captureMac(pid, env, timeoutMs);
    case "win32":
      return captureWindows(pid, env, timeoutMs);
    default:
      return undefined;
  }
}

export async function verifyFingerprint(
  expected: ProcessFingerprint,
  opts: FingerprintOptions,
): Promise<VerifyResult> {
  const { pid } = opts;
  if (!isProcessAlive(pid)) {
    return { alive: false, matches: false, detail: `pid ${pid} is not alive` };
  }
  const current = await captureFingerprint(opts);
  if (!current) {
    return {
      alive: true,
      matches: false,
      detail: `could not capture current fingerprint for pid ${pid} on ${opts.env.platform}; refusing to assert match`,
      current: undefined,
    };
  }
  const sameCreation = current.creationTime === expected.creationTime;
  const sameCmd = current.commandLine === expected.commandLine;
  if (sameCreation && sameCmd) {
    return { alive: true, matches: true, detail: "fingerprint matches", current };
  }
  return {
    alive: true,
    matches: false,
    detail: `fingerprint mismatch. creationTime equal: ${sameCreation}. commandLine equal: ${sameCmd}`,
    current,
  };
}
