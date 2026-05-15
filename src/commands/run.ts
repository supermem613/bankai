import { resolve } from "node:path";
import { createNodeEnv, type Env } from "../env-runtime/env.js";
import { createRunLogger, type RunLogger } from "../log/jsonl.js";
import { resolveRepoRoot } from "../repo-root.js";
import { createRegistryStore } from "../registry/store.js";
import { loadPlan } from "../plan/load.js";
import { runPlan } from "../orchestrator/run.js";
import type { BankaiEnvelope } from "../plan/envelope.js";

// `bankai run <plan>` — execute a plan to completion. The verb is
// agnostic to step kinds; the plan picks them.

export interface RunCommandOptions {
  planPath: string;
  env?: Env;
  logDir?: string;
  logFile?: string;
  repoRoot?: string;
  /** Optional pre-built logger (used by tests to share log files). */
  logger?: RunLogger;
}

export async function runRunCommand(opts: RunCommandOptions): Promise<BankaiEnvelope> {
  const env = opts.env ?? createNodeEnv();
  const repoRoot = resolveRepoRoot({ env, override: opts.repoRoot });
  const startedAt = env.clock.isoNow();
  const startedNow = env.clock.now();
  const loaded = await loadPlan({ env, planPath: opts.planPath });
  const planName = loaded.ok ? loaded.plan.name : undefined;

  const logger = opts.logger ?? createRunLogger({
    env,
    command: "run",
    logsDir: opts.logDir ?? resolve(repoRoot, ".bankai", "logs"),
    logFile: opts.logFile,
    planName,
  });

  if (!loaded.ok) {
    logger.emit("run.start", { planPath: loaded.planPath });
    logger.emit("plan.load-error", { planPath: loaded.planPath, reason: loaded.reason, detail: loaded.detail });
    const finishedAt = env.clock.isoNow();
    const envelope: BankaiEnvelope = {
      ok: false,
      command: "run",
      startedAt,
      finishedAt,
      durationMs: env.clock.now() - startedNow,
      runId: logger.runId,
      logFile: logger.logFilePath,
      planPath: loaded.planPath,
      steps: [],
      failure: {
        stage: "load-plan",
        reason: loaded.reason,
        detail: loaded.detail,
      },
    };
    if (opts.logger === undefined) {
      await logger.close();
    }
    return envelope;
  }

  logger.emit("run.start", { planName: loaded.plan.name, planPath: loaded.planPath, repoRoot });
  const registry = createRegistryStore({ env });
  const envelope = await runPlan({
    env,
    plan: loaded.plan,
    planPath: loaded.planPath,
    repoRoot,
    logger,
    registry,
  });
  logger.emit("run.end", { ok: envelope.ok, durationMs: envelope.durationMs });
  if (opts.logger === undefined) {
    await logger.close();
  }
  return envelope;
}
