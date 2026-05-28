import { createNodeEnv, type Env } from "../env-runtime/env.js";
import { createRunLogger, defaultBankaiLogsDir, type RunLogger } from "../log/jsonl.js";
import { resolveRepoRoot } from "../repo-root.js";
import { createRegistryStore } from "../registry/store.js";
import { getStatusRegistryEntries } from "./status.js";
import { loadPlan } from "../plan/load.js";
import { runPlan } from "../orchestrator/run.js";
import type { BankaiEnvelope } from "../plan/envelope.js";
import { dirname, join } from "node:path";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import {
  type BindingEntry,
  parseBindingsJson,
  readBindingsFile,
  resolveBindings,
} from "../bindings.js";

// `bankai run <plan>` — execute a plan to completion. The verb is
// agnostic to step kinds; the plan picks them.

export interface RunCommandOptions {
  planPath: string;
  env?: Env;
  logDir?: string;
  logFile?: string;
  repoRoot?: string;
  bindingsFile?: string;
  bindingsJson?: string;
  bindings?: BindingEntry[];
  signal?: AbortSignal;
  visibleAttachedTerminal?: boolean;
  visibleReadyEventFile?: string;
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
    logsDir: opts.logDir ?? defaultBankaiLogsDir(env),
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
    await writeVisibleReadyFailure({ path: opts.visibleReadyEventFile, env, logger, envelope });
    return envelope;
  }

  const suppliedBindings = await collectBindings({
    env,
    bindings: opts.bindings,
    bindingsFile: opts.bindingsFile,
    bindingsJson: opts.bindingsJson,
  });
  if (!suppliedBindings.ok) {
    const finishedAt = env.clock.isoNow();
    const envelope: BankaiEnvelope = {
      ok: false,
      command: "run",
      startedAt,
      finishedAt,
      durationMs: env.clock.now() - startedNow,
      runId: logger.runId,
      logFile: logger.logFilePath,
      planName: loaded.plan.name,
      planPath: loaded.planPath,
      steps: [],
      failure: {
        stage: "validation",
        reason: suppliedBindings.reason,
      },
    };
    logger.emit("bindings.load-error", { reason: suppliedBindings.reason });
    if (opts.logger === undefined) {
      await logger.close();
    }
    await writeVisibleReadyFailure({ path: opts.visibleReadyEventFile, env, logger, envelope });
    return envelope;
  }

  const resolvedBindings = resolveBindings(loaded.plan.requires, [
    ...automaticBindings({ env, repoRoot, planPath: loaded.planPath, logger }),
    ...suppliedBindings.bindings,
  ]);
  if (!resolvedBindings.ok) {
    const finishedAt = env.clock.isoNow();
    const envelope: BankaiEnvelope = {
      ok: false,
      command: "run",
      startedAt,
      finishedAt,
      durationMs: env.clock.now() - startedNow,
      runId: logger.runId,
      logFile: logger.logFilePath,
      planName: loaded.plan.name,
      planPath: loaded.planPath,
      steps: [],
      failure: {
        stage: "validation",
        reason: `binding validation failed: ${resolvedBindings.errors.join("; ")}`,
        detail: { errors: resolvedBindings.errors },
      },
    };
    logger.emit("bindings.validation-error", { errors: resolvedBindings.errors });
    if (opts.logger === undefined) {
      await logger.close();
    }
    await writeVisibleReadyFailure({ path: opts.visibleReadyEventFile, env, logger, envelope });
    return envelope;
  }

  logger.emit("run.start", {
    planName: loaded.plan.name,
    planPath: loaded.planPath,
    repoRoot,
    bindingKeys: Object.keys(resolvedBindings.bindings).sort(),
  });
  const registry = createRegistryStore({ env });
  const visibleReadyEventFile = opts.visibleReadyEventFile
    ?? (opts.visibleAttachedTerminal === true ? `${logger.logFilePath}.ready.json` : undefined);
  const envelope = await runPlan({
    env,
    plan: loaded.plan,
    planPath: loaded.planPath,
    repoRoot,
    bindings: resolvedBindings.bindings,
    logger,
    registry,
    parentSignal: opts.signal,
    visibleAttachedTerminal: opts.visibleAttachedTerminal === true,
    visibleReadyEventFile,
  });
  const registerNames = registeredNames(loaded.plan.steps);
  if (registerNames.length > 0) {
    envelope.registry = await getStatusRegistryEntries({ env, names: registerNames });
  }
  logger.emit("run.end", { ok: envelope.ok, durationMs: envelope.durationMs });
  if (opts.logger === undefined) {
    await logger.close();
  }
  return envelope;
}

async function writeVisibleReadyFailure(opts: {
  path: string | undefined;
  env: Env;
  logger: RunLogger;
  envelope: BankaiEnvelope;
}): Promise<void> {
  if (!opts.path) {
    return;
  }
  try {
    await writeJsonAtomic(opts.path, {
      event: "bankai.failed",
      ok: false,
      command: opts.envelope.command,
      planName: opts.envelope.planName,
      planPath: opts.envelope.planPath,
      failedAt: opts.env.clock.isoNow(),
      failure: opts.envelope.failure,
      logFile: opts.envelope.logFile,
    });
  } catch (err) {
    opts.logger.emit("visible-ready-event.write-error", {
      path: opts.path,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rm(path, { force: true });
  await rename(tmp, path);
}

function automaticBindings(opts: { env: Env; repoRoot: string; planPath: string; logger: RunLogger }): BindingEntry[] {
  return [
    { key: "bankaiRunId", value: opts.logger.runId },
    { key: "bankaiLogFile", value: opts.logger.logFilePath },
    { key: "bankaiOutputDir", value: join(opts.env.home, ".bankai", "out", opts.logger.runId) },
    { key: "bankaiPlanDir", value: dirname(opts.planPath) },
    { key: "bankaiWorkDir", value: opts.repoRoot },
  ];
}

function registeredNames(steps: readonly unknown[]): string[] {
  const names = new Set<string>();
  for (const step of steps) {
    const registerAs = (step as { registerAs?: unknown }).registerAs;
    if (typeof registerAs === "string" && registerAs.length > 0) {
      names.add(registerAs);
    }
  }
  return [...names];
}

type CollectBindingsResult =
  | { ok: true; bindings: BindingEntry[] }
  | { ok: false; reason: string };

async function collectBindings(opts: {
  env: Env;
  bindings?: BindingEntry[];
  bindingsFile?: string;
  bindingsJson?: string;
}): Promise<CollectBindingsResult> {
  const bindings: BindingEntry[] = [...(opts.bindings ?? [])];
  try {
    if (opts.bindingsFile) {
      bindings.push(...await readBindingsFile({ env: opts.env, path: opts.bindingsFile }));
    }
    if (opts.bindingsJson) {
      bindings.push(...parseBindingsJson(opts.bindingsJson));
    }
  } catch (err) {
    return {
      ok: false,
      reason: `could not parse bindings: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, bindings };
}
