import { z } from "zod";
import { spawn } from "node:child_process";
import { mkdir, open as openFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type {
  EnvironmentPlugin,
  LongRunningContext,
  DevLoopHandle,
  CheckResult,
} from "./interface.js";
import { registerEnvironment } from "./registry.js";
import { captureFingerprint } from "../dev-loop/fingerprint.js";

// managed-process: a generic spawn-and-track environment plugin for the
// dev-loop CLI. It owns nothing about a specific framework. A plan that
// uses this plugin describes the long-running command directly:
//
//   {
//     "schemaVersion": "1",
//     "name": "node-http-server",
//     "environment": {
//       "kind": "managed-process",
//       "config": {
//         "command": "node",
//         "args": ["server.js"],
//         "cwd": ".",
//         "logFile": ".bankai/logs/node-http-server.log"
//       }
//     },
//     "readiness": [{ "kind": "port", "id": "p", "port": 8080 }]
//   }
//
// Invariants the next editor must preserve:
//   1. Spawn is detached on POSIX. The child becomes its own process
//      group leader so terminateProcessTree(-pid, signal) reaches the
//      whole subtree on stop. Removing detached:true leaks descendants
//      and silently breaks dev-loop stop.
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
//   5. setup throws on this plugin: managed-process is dev-loop only.
//      The test runner uses the noop plugin (or a future setup-only
//      plugin) instead. This separation prevents test scenarios from
//      accidentally leaking detached processes.
//   6. NEVER persist the env block in DevLoopHandle. Secrets in env
//      vars must not leak through state.

export const ManagedProcessConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).default("."),
  logFile: z.string().min(1),
  env: z.record(z.string(), z.string()).optional(),
});

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
    // managed-process intentionally rejects scoped setup. Test scenarios
    // that need a long-lived helper should compose a separate plugin.
    throw new Error(
      "managed-process is a dev-loop-only environment. Use bankai dev-loop start, not bankai test run.",
    );
  },

  async startLongRunning(ctx: LongRunningContext, config: ManagedProcessConfig): Promise<DevLoopHandle> {
    const cwdAbs = isAbsolute(config.cwd) ? config.cwd : resolve(ctx.workDir, config.cwd);
    const logFileAbs = await ensureLogPath(cwdAbs, config.logFile);
    const logStartOffset = await getFileSizeOrZero(logFileAbs);

    // Open the log file in append mode. We get a file handle, then dup
    // its underlying fd into the child's stdout and stderr. After spawn
    // we close OUR handle so bankai does not keep the file pinned open.
    const logHandle = await openFile(logFileAbs, "a");
    let pid: number;
    try {
      const child = spawn(config.command, config.args, {
        cwd: cwdAbs,
        detached: true,
        stdio: ["ignore", logHandle.fd, logHandle.fd],
        env: config.env ? { ...ctx.env.env, ...config.env } : { ...ctx.env.env },
        windowsHide: true,
      });
      // Listen for early failure: a missing binary surfaces as 'error'
      // before any child output. We resolve the spawn race by waiting
      // a microtask plus a brief tick to give the OS a chance to fail.
      const earlyFail = new Promise<Error | undefined>((resolveErr) => {
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
      const earlyErr = await earlyFail;
      if (earlyErr) {
        throw earlyErr;
      }
      if (typeof child.pid !== "number") {
        throw new Error("spawn did not return a pid");
      }
      pid = child.pid;
      child.unref();
    } finally {
      await logHandle.close();
    }

    const fingerprint = await captureFingerprint({ pid, env: ctx.env });
    return {
      pid,
      command: config.command,
      args: config.args,
      workDir: cwdAbs,
      logFile: logFileAbs,
      logStartOffset,
      fingerprint,
    };
  },
};

registerEnvironment(managedProcessPlugin);
