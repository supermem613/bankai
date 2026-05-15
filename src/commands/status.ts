import { resolve } from "node:path";
import { createNodeEnv, type Env } from "../env-runtime/env.js";
import { createRunLogger } from "../log/jsonl.js";
import { resolveRepoRoot } from "../repo-root.js";
import { createRegistryStore } from "../registry/store.js";
import { isProcessAlive } from "../process-tree.js";
import type { BankaiEnvelope } from "../plan/envelope.js";

// `bankai status [name]` — read the per-user shared registry and
// report what's running. NO plan is required. This is the escape hatch
// for "what did I leave behind?"

export interface StatusCommandOptions {
  name?: string;
  env?: Env;
  logDir?: string;
  logFile?: string;
  repoRoot?: string;
}

export async function runStatusCommand(opts: StatusCommandOptions): Promise<BankaiEnvelope> {
  const env = opts.env ?? createNodeEnv();
  const repoRoot = resolveRepoRoot({ env, override: opts.repoRoot });
  const startedAt = env.clock.isoNow();
  const startedNow = env.clock.now();
  const logger = createRunLogger({
    env,
    command: "status",
    logsDir: opts.logDir ?? resolve(repoRoot, ".bankai", "logs"),
    logFile: opts.logFile,
    planName: opts.name,
  });
  logger.emit("status.start", { name: opts.name, repoRoot });
  const store = createRegistryStore({ env });
  const file = await store.read();
  const all = Object.values(file.entries);
  const filtered = opts.name ? all.filter((e) => e.name === opts.name) : all;
  const enriched = filtered.map((e) => ({
    ...e,
    alive: isProcessAlive(e.pid),
  }));
  for (const e of enriched) {
    logger.emit("status.entry", { name: e.name, pid: e.pid, envKind: e.envKind, alive: e.alive });
  }
  const finishedAt = env.clock.isoNow();
  const envelope: BankaiEnvelope = {
    ok: true,
    command: "status",
    startedAt,
    finishedAt,
    durationMs: env.clock.now() - startedNow,
    runId: logger.runId,
    logFile: logger.logFilePath,
    steps: [],
    registry: enriched,
  };
  logger.emit("status.end", { count: enriched.length });
  await logger.close();
  return envelope;
}
