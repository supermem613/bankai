import { dirname } from "node:path";
import { existsSync, watch } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createNodeEnv, type Env } from "../env-runtime/env.js";
import { createRunLogger, defaultBankaiLogsDir } from "../log/jsonl.js";
import { createRegistryStore } from "../registry/store.js";
import { isProcessAlive, listProcessTreePids, terminateProcessTree, terminateProcessTrees, waitForPidsExit } from "../process-tree.js";
import { verifyFingerprint } from "../fingerprint.js";
import { stopViaStdin } from "../stop-stdin.js";
import type { BankaiEnvelope } from "../plan/envelope.js";
import type { RunLogger } from "../log/jsonl.js";
import type { RegistryEntry } from "../registry/types.js";

async function waitForFileCreated(path: string, timeoutMs: number): Promise<boolean> {
  if (existsSync(path)) {
    return true;
  }
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  return await new Promise((resolveWait) => {
    let settled = false;
    const settle = (result: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearInterval(poller);
      watcher.close();
      resolveWait(result);
    };
    const timer = setTimeout(() => {
      settle(existsSync(path));
    }, timeoutMs);
    const watcher = watch(dir, () => {
      if (existsSync(path)) {
        settle(true);
      }
    });
    // Poll fallback: fs.watch on Windows can silently miss the create event.
    const poller = setInterval(() => {
      if (existsSync(path)) {
        settle(true);
      }
    }, 250);
  });
}

// `bankai stop <name> [--force]` — terminate a registered handle by
// name. The escape hatch when bankai exited mid-run or when a user
// just wants to shut something down without writing a stop step plan.
//
// Mirrors the `stop` step kind logic but accepts CLI flags directly.

export interface StopCommandOptions {
  name: string;
  force?: boolean;
  graceMs?: number;
  env?: Env;
  logDir?: string;
  logFile?: string;
  repoRoot?: string;
}

export async function runStopCommand(opts: StopCommandOptions): Promise<BankaiEnvelope> {
  const env = opts.env ?? createNodeEnv();
  const graceMs = opts.graceMs ?? 5000;
  const startedAt = env.clock.isoNow();
  const startedNow = env.clock.now();
  const logger = createRunLogger({
    env,
    command: "stop",
    logsDir: opts.logDir ?? defaultBankaiLogsDir(env),
    logFile: opts.logFile,
    planName: opts.name,
  });
  logger.emit("stop.start", { name: opts.name, force: opts.force, graceMs });

  const store = createRegistryStore({ env });
  const entry = await store.getEntry(opts.name);
  let detail = "";
  let killed = false;
  let escalated = false;
  let failure: BankaiEnvelope["failure"];

  if (!entry) {
    detail = `no registered handle named "${opts.name}"`;
    killed = true;
    logger.emit("stop.not-registered", { name: opts.name });
  } else if (!isProcessAlive(entry.pid)) {
    detail = `pid ${entry.pid} was already dead. Stale registry entry removed.`;
    killed = true;
    await store.removeEntry(opts.name);
    logger.emit("registry.remove", { name: opts.name, pid: entry.pid });
  } else {
    if (entry.fingerprint && !opts.force) {
      const v = await verifyFingerprint(entry.fingerprint, { pid: entry.pid, env });
      logger.emit("stop.fingerprint", { name: opts.name, matched: v.matches, detail: v.detail });
      if (!v.matches) {
        failure = {
          stage: "fingerprint",
          reason: `fingerprint mismatch for "${opts.name}" (pid ${entry.pid}). Use --force after manual investigation.`,
          detail: { detail: v.detail },
        };
        detail = v.detail;
        const finishedAt = env.clock.isoNow();
        const envelope: BankaiEnvelope = {
          ok: false,
          command: "stop",
          startedAt,
          finishedAt,
          durationMs: env.clock.now() - startedNow,
          runId: logger.runId,
          logFile: logger.logFilePath,
          steps: [],
          registry: [{ ...entry, alive: true, killed, escalated, detail }],
          failure,
        };
        logger.emit("stop.end", { ok: false });
        await logger.close();
        return envelope;
      }
    }
    const r = entry.envKind === "attached-process" && entry.control
      ? await stopAttachedProcess({ entry, graceMs, env, logger })
      : entry.stop?.kind === "stdin"
        ? await stopManagedProcessViaStdin({ entry, graceMs, env, logger })
        : await terminateProcessTree({ pid: entry.pid, graceMs, env });
    killed = r.killed;
    escalated = r.escalated;
    detail = r.detail;
    logger.emit("stop.terminated", { name: opts.name, pid: entry.pid, killed, escalated, detail });
    if (killed) {
      await store.removeEntry(opts.name);
      logger.emit("registry.remove", { name: opts.name, pid: entry.pid });
    } else {
      failure = { stage: "stop", reason: detail };
    }
  }

  const finishedAt = env.clock.isoNow();
  const envelope: BankaiEnvelope = {
    ok: !failure,
    command: "stop",
    startedAt,
    finishedAt,
    durationMs: env.clock.now() - startedNow,
    runId: logger.runId,
    logFile: logger.logFilePath,
    steps: [],
    registry: entry ? [{ ...entry, killed, escalated, detail }] : [],
    failure,
  };
  logger.emit("stop.end", { ok: envelope.ok });
  await logger.close();
  return envelope;
}

async function stopAttachedProcess(opts: {
  entry: RegistryEntry;
  graceMs: number;
  env: Env;
  logger: RunLogger;
}): Promise<{ killed: boolean; escalated: boolean; detail: string }> {
  const { entry, graceMs, env, logger } = opts;
  if (!entry.control) {
    return terminateProcessTree({ pid: entry.pid, graceMs, env });
  }
  const trackedPids = await listProcessTreePids({ pid: entry.pid, env });
  logger.emit("stop.attached.tracked", {
    name: entry.name,
    pid: entry.pid,
    trackedPids,
  });
  await mkdir(dirname(entry.control.stopRequestFile), { recursive: true });
  await writeFile(entry.control.stopRequestFile, JSON.stringify({
    requestedAt: env.clock.isoNow(),
    target: entry.name,
    pid: entry.pid,
    signal: "ctrl-c",
  }, null, 2) + "\n", "utf8");
  logger.emit("stop.attached.requested", {
    name: entry.name,
    pid: entry.pid,
    stopRequestFile: entry.control.stopRequestFile,
    stopDoneFile: entry.control.stopDoneFile,
  });
  const stopped = await waitForFileCreated(entry.control.stopDoneFile, graceMs);
  if (stopped) {
    const exited = await waitForPidsExit(trackedPids, 2000);
    if (exited) {
      return { killed: true, escalated: false, detail: "attached Ctrl+C stop completed and tracked process tree exited" };
    }
    const forced = await terminateProcessTrees({ pids: trackedPids, graceMs: 2000, env });
    return {
      killed: forced.killed,
      escalated: forced.escalated,
      detail: `attached Ctrl+C stop completed but tracked pids remained; ${forced.detail}`,
    };
  }
  const forced = await terminateProcessTrees({ pids: trackedPids.length > 0 ? trackedPids : [entry.pid], graceMs: 2000, env });
  return {
    killed: forced.killed,
    escalated: true,
    detail: `attached Ctrl+C stop timed out after ${graceMs}ms; ${forced.detail}`,
  };
}

async function stopManagedProcessViaStdin(opts: {
  entry: RegistryEntry;
  graceMs: number;
  env: Env;
  logger: RunLogger;
}): Promise<{ killed: boolean; escalated: boolean; detail: string }> {
  const { entry, graceMs, env, logger } = opts;
  if (!entry.stop || entry.stop.kind !== "stdin") {
    return terminateProcessTree({ pid: entry.pid, graceMs, env });
  }

  // Use graceMs from the persisted strategy if present, CLI/step
  // override takes precedence (already resolved into opts.graceMs by
  // the caller when explicitly provided).
  const effectiveGrace = entry.stop.graceMs ?? graceMs;

  logger.emit("stop.stdin.begin", {
    name: entry.name,
    pid: entry.pid,
    stdinFile: entry.stop.stdinFile,
    graceMs: effectiveGrace,
  });

  const result = await stopViaStdin({
    stop: entry.stop,
    pid: entry.pid,
    graceMs: effectiveGrace,
    env,
  });

  logger.emit("stop.stdin.result", {
    name: entry.name,
    delivered: result.delivered,
    exited: result.exited,
    detail: result.detail,
  });

  if (result.exited) {
    return { killed: true, escalated: false, detail: result.detail };
  }

  // Escalate: stdin delivery failed or process did not exit in time.
  logger.emit("stop.stdin.escalate", { name: entry.name, pid: entry.pid });
  const fallback = await terminateProcessTree({ pid: entry.pid, graceMs, env });
  return {
    killed: fallback.killed,
    escalated: true,
    detail: `${result.detail}; escalated to process-tree termination: ${fallback.detail}`,
  };
}
