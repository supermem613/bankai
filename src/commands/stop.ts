import { resolve } from "node:path";
import { createNodeEnv, type Env } from "../env-runtime/env.js";
import { createRunLogger } from "../log/jsonl.js";
import { resolveRepoRoot } from "../repo-root.js";
import { createRegistryStore } from "../registry/store.js";
import { isProcessAlive, terminateProcessTree } from "../process-tree.js";
import { verifyFingerprint } from "../fingerprint.js";
import type { BankaiEnvelope } from "../plan/envelope.js";

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
  const repoRoot = resolveRepoRoot({ env, override: opts.repoRoot });
  const graceMs = opts.graceMs ?? 5000;
  const startedAt = env.clock.isoNow();
  const startedNow = env.clock.now();
  const logger = createRunLogger({
    env,
    command: "stop",
    logsDir: opts.logDir ?? resolve(repoRoot, ".bankai", "logs"),
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
    const r = await terminateProcessTree({ pid: entry.pid, graceMs, env });
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
