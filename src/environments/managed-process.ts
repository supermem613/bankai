import { z } from "zod";
import { spawn } from "node:child_process";
import { mkdir, open as openFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, join } from "node:path";
import type {
  EnvironmentPlugin,
  LongRunningContext,
  CheckResult,
} from "./interface.js";
import type { ProcessHandle } from "../registry/types.js";
import { registerEnvironment } from "./registry.js";
import { captureFingerprint } from "../fingerprint.js";

// managed-process: a generic spawn-and-track environment plugin. A
// `setup` step that names this plugin spawns a long-lived child process
// described by config:
//
//   { "kind": "setup", "id": "server", "registerAs": "node-http",
//     "env": "managed-process",
//     "config": { "command": "node", "args": ["server.js"], "logFile": "logs/s.log" } }
//
// Invariants the next editor must preserve:
//   1. Spawn is detached on POSIX. The child becomes its own process
//      group leader so terminateProcessTree(-pid, signal) reaches the
//      whole subtree on stop. Removing detached:true leaks descendants
//      and silently breaks bankai stop.
//   2. The child's stdio is wired to the log file via fds. We open the
//      log file once, dup the fd into stdout and stderr of the child,
//      then close OUR copy after spawn so we do not pin the file open
//      after bankai exits.
//   3. We capture the log file size BEFORE spawn and persist that as
//      logStartOffset on the returned handle. This is what tells the
//      log-line-matches readiness probe to ignore output from the
//      previous run that lives earlier in the same file.
//   4. We child.unref() after spawn so node's event loop does not wait
//      for the long-lived process. bankai must be free to exit.
//   5. setup throws on this plugin: managed-process always uses the
//      detached/long-running surface. A scoped setup step that wants
//      a scoped helper should use a different plugin.
//   6. NEVER persist the env block in ProcessHandle. Secrets in env
//      vars must not leak through the registry.
//   7. When stop.kind is "stdin", the child is spawned through a thin
//      relay wrapper that holds the real child's stdin pipe open. The
//      relay watches a trigger file. When bankai stop writes the
//      configured input to the trigger file, the relay pipes it to the
//      child's stdin. This is cross-platform: no FIFOs, no platform-
//      specific named pipes. The relay is in the same process group so
//      process-tree termination still works as fallback.

// Plan-facing stop config. The plan author declares what to send.
// The stdinFile (trigger file) is computed at spawn time and persisted.
export const ManagedProcessStopConfigSchema = z.object({
  kind: z.literal("stdin"),
  input: z.string().min(1),
  graceMs: z.number().int().nonnegative().optional(),
}).strict();

export type ManagedProcessStopConfig = z.infer<typeof ManagedProcessStopConfigSchema>;

export const ManagedProcessConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).default("."),
  logFile: z.string().min(1),
  env: z.record(z.string(), z.string()).optional(),
  stop: ManagedProcessStopConfigSchema.optional(),
}).strict();

export type ManagedProcessConfig = z.infer<typeof ManagedProcessConfigSchema>;

async function ensureLogPath(workDir: string, relOrAbs: string): Promise<string> {
  const abs = isAbsolute(relOrAbs) ? relOrAbs : resolve(workDir, relOrAbs);
  await mkdir(dirname(abs), { recursive: true });
  return abs;
}

async function getFileSizeOrZero(path: string): Promise<number> {
  try {
    const s = await stat(path);
    return s.size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw err;
  }
}

// The relay script is a self-contained CJS module that:
//   1. Spawns the real command with stdin piped
//   2. Watches a trigger file directory
//   3. When the trigger file appears, reads it and writes content to
//      the child's stdin, then closes stdin
//   4. Exits with the child's exit code
// This keeps the child's stdin open and reachable from a separate
// bankai stop process via the filesystem — fully cross-platform.
function generateRelayScript(triggerFilePath: string): string {
  const escaped = JSON.stringify(triggerFilePath);
  return `'use strict';
const { spawn } = require('child_process');
const { watch, readFileSync, existsSync } = require('fs');
const { dirname, basename } = require('path');

const triggerPath = ${escaped};
const cmd = process.argv[2];
const args = process.argv.slice(3);

if (!cmd) {
  process.stderr.write('bankai relay: no command specified\\n');
  process.exit(1);
}

const child = spawn(cmd, args, {
  stdio: ['pipe', 'inherit', 'inherit'],
  windowsHide: true,
});

child.on('error', (err) => {
  process.stderr.write('bankai relay: child spawn error: ' + err.message + '\\n');
  process.exit(1);
});

let triggered = false;

function deliverInput() {
  if (triggered) return;
  triggered = true;
  try {
    const content = readFileSync(triggerPath, 'utf8');
    child.stdin.write(content, () => {
      child.stdin.end();
    });
  } catch (err) {
    process.stderr.write('bankai relay: failed to read trigger: ' + err.message + '\\n');
  }
  if (watcher) watcher.close();
}

const dir = dirname(triggerPath);
const base = basename(triggerPath);
let watcher;
try {
  watcher = watch(dir, (event, filename) => {
    if ((filename === base || !filename) && existsSync(triggerPath)) {
      deliverInput();
    }
  });
  watcher.on('error', () => {});
} catch (err) {
  process.stderr.write('bankai relay: watch error: ' + err.message + '\\n');
}

// Poll fallback in case fs.watch misses the event (common on some OS/fs combos)
const pollInterval = setInterval(() => {
  if (existsSync(triggerPath)) deliverInput();
}, 500);

child.on('exit', (code, signal) => {
  if (watcher) watcher.close();
  clearInterval(pollInterval);
  if (signal) {
    process.exit(1);
  }
  process.exit(code ?? 0);
});
`;
}

import type { ChildProcess } from "node:child_process";

function waitForEarlyFailure(child: ChildProcess): Promise<Error | undefined> {
  return new Promise<Error | undefined>((resolveErr) => {
    const onErr = (err: Error): void => {
      child.removeListener("exit", onExit);
      resolveErr(err);
    };
    const onExit = (code: number | null): void => {
      child.removeListener("error", onErr);
      if (code !== null && code !== 0) {
        resolveErr(new Error(`process exited with code ${code} immediately after spawn`));
      } else {
        resolveErr(undefined);
      }
    };
    child.once("error", onErr);
    child.once("exit", onExit);
    setTimeout(() => {
      child.removeListener("error", onErr);
      child.removeListener("exit", onExit);
      resolveErr(undefined);
    }, 200);
  });
}

export const managedProcessPlugin: EnvironmentPlugin<typeof ManagedProcessConfigSchema, never> = {
  kind: "managed-process",
  configSchema: ManagedProcessConfigSchema,

  async doctor(_env, config): Promise<CheckResult[]> {
    const checks: CheckResult[] = [];
    if (!config) {
      checks.push({
        name: "config",
        ok: true,
        detail: "no config supplied; skipping config-aware checks",
      });
      return checks;
    }
    checks.push({
      name: "command",
      ok: config.command.length > 0,
      detail: config.command.length > 0 ? `command: ${config.command}` : "command is empty",
    });
    try {
      const abs = await ensureLogPath(config.cwd, config.logFile);
      checks.push({ name: "logFile", ok: true, detail: `log path writable: ${abs}` });
    } catch (err) {
      checks.push({
        name: "logFile",
        ok: false,
        detail: `cannot create log path: ${(err as Error).message}`,
      });
    }
    return checks;
  },

  async setup(): Promise<never> {
    // managed-process intentionally rejects scoped setup. A setup step
    // that uses this plugin must include `registerAs` so the
    // orchestrator routes through startLongRunning.
    throw new Error(
      "managed-process is detached-only. Add `registerAs` to the setup step so the handle persists in the registry.",
    );
  },

  async startLongRunning(ctx: LongRunningContext, config: ManagedProcessConfig): Promise<ProcessHandle> {
    const cwdAbs = isAbsolute(config.cwd) ? config.cwd : resolve(ctx.workDir, config.cwd);
    const logFileAbs = await ensureLogPath(cwdAbs, config.logFile);
    const logStartOffset = await getFileSizeOrZero(logFileAbs);

    // Open the log file in append mode. We get a file handle, then dup
    // its underlying fd into the child's stdout and stderr. After spawn
    // we close OUR handle so bankai does not keep the file pinned open.
    const logHandle = await openFile(logFileAbs, "a");
    let pid: number;
    let stdinTriggerFile: string | undefined;

    try {
      if (config.stop?.kind === "stdin") {
        // Cross-platform stdin stop: spawn a relay wrapper that holds
        // the real child's stdin pipe and watches a trigger file. When
        // the trigger file appears, the relay writes its content to the
        // child's stdin. Works identically on POSIX and Windows.
        const stateDir = join(dirname(logFileAbs), ".bankai-stdin");
        await mkdir(stateDir, { recursive: true });
        stdinTriggerFile = join(stateDir, `stdin-trigger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

        const relayScript = generateRelayScript(stdinTriggerFile);
        const relayPath = join(stateDir, `relay-${Date.now()}.cjs`);
        await writeFile(relayPath, relayScript, "utf8");

        const child = spawn(process.execPath, [relayPath, config.command, ...config.args], {
          cwd: cwdAbs,
          detached: true,
          stdio: ["ignore", logHandle.fd, logHandle.fd],
          env: config.env ? { ...ctx.env.env, ...config.env } : { ...ctx.env.env },
          windowsHide: true,
        });

        const earlyErr = await waitForEarlyFailure(child);
        if (earlyErr) {
          throw earlyErr;
        }
        if (typeof child.pid !== "number") {
          throw new Error("spawn did not return a pid");
        }
        pid = child.pid;
        child.unref();
      } else {
        // Standard path: no stdin stop strategy. Stdin is ignored.
        const child = spawn(config.command, config.args, {
          cwd: cwdAbs,
          detached: true,
          stdio: ["ignore", logHandle.fd, logHandle.fd],
          env: config.env ? { ...ctx.env.env, ...config.env } : { ...ctx.env.env },
          windowsHide: true,
        });

        const earlyErr = await waitForEarlyFailure(child);
        if (earlyErr) {
          throw earlyErr;
        }
        if (typeof child.pid !== "number") {
          throw new Error("spawn did not return a pid");
        }
        pid = child.pid;
        child.unref();
      }
    } finally {
      await logHandle.close();
    }

    const fingerprint = await captureFingerprint({ pid, env: ctx.env });
    const handle: ProcessHandle = {
      pid,
      command: config.command,
      args: config.args,
      workDir: cwdAbs,
      envKind: "managed-process",
      logFile: logFileAbs,
      logStartOffset,
      fingerprint,
    };

    if (config.stop?.kind === "stdin" && stdinTriggerFile) {
      handle.stop = {
        kind: "stdin",
        input: config.stop.input,
        graceMs: config.stop.graceMs,
        stdinFile: stdinTriggerFile,
      };
    }

    return handle;
  },
};

registerEnvironment(managedProcessPlugin);
