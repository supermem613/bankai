import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createNodeEnv, type Env } from "../env-runtime/env.js";
import { createRunLogger, defaultBankaiLogsDir } from "../log/jsonl.js";
import { resolveRepoRoot } from "../repo-root.js";
import { createRegistryStore } from "../registry/store.js";
import { isProcessAlive } from "../process-tree.js";
import type { BankaiEnvelope } from "../plan/envelope.js";
import type { RegistryEntry } from "../registry/types.js";

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

export interface StatusLifecycle {
  phase: "launching" | "starting" | "running" | "ready" | "done" | "failed" | "stale";
  currentStepId?: string;
  currentStepKind?: string;
  done: boolean;
  ready: boolean;
  detail: string;
}

export interface StatusStepSummary {
  id: string;
  kind?: string;
  phase: "running" | "ready" | "succeeded" | "failed";
  ok?: boolean;
}

interface TailResult {
  path?: string;
  exists: boolean;
  error?: string;
  raw?: string;
}

interface LogSummary {
  lastEvent: string;
  lastFatalDetail?: string;
  lastProgress?: string;
}

async function readTail(path: string | undefined): Promise<TailResult> {
  if (!path) {
    return { exists: false };
  }
  if (!existsSync(path)) {
    return { path, exists: false };
  }
  try {
    const raw = await readFile(path, "utf8");
    return {
      path,
      exists: true,
      raw,
    };
  } catch (err) {
    return {
      path,
      exists: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function summarizeLifecycle(entry: RegistryEntry, alive: boolean, rawLog: string | undefined): {
  status: StatusLifecycle;
  steps: StatusStepSummary[];
} {
  const logSummary = summarizeLog(rawLog);
  if (!alive) {
    return {
      status: {
        phase: entry.evidence?.lastResult?.ok === false ? "failed" : "stale",
        done: true,
        ready: false,
        detail: entry.evidence?.lastResult?.detail ?? logSummary.lastFatalDetail ?? "registered process is not alive",
      },
      steps: [],
    };
  }
  if (logSummary.lastFatalDetail) {
    return {
      status: {
        phase: "failed",
        done: true,
        ready: false,
        detail: logSummary.lastFatalDetail,
      },
      steps: [],
    };
  }
  if (entry.envKind === "visible-terminal-launch") {
    return {
      status: {
        phase: "launching",
        done: false,
        ready: false,
        detail: logSummary.lastProgress
          ? `visible terminal launched. Latest child progress: ${logSummary.lastProgress}`
          : "visible terminal launched. Waiting for child runner to register the live process.",
      },
      steps: [],
    };
  }
  let currentStepId: string | undefined;
  let currentStepKind: string | undefined;
  let ready = false;
  let done = false;
  let failed = false;
  let lastEvent = logSummary.lastEvent;
  const steps = new Map<string, StatusStepSummary>();
  for (const line of (rawLog ?? "").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const event = JSON.parse(line) as {
        event?: string;
        stepId?: string;
        kind?: string;
        ok?: boolean;
      };
      lastEvent = event.event ?? lastEvent;
      if (event.event === "step.start") {
        currentStepId = event.stepId;
        currentStepKind = event.kind;
        if (event.stepId) {
          steps.set(event.stepId, { id: event.stepId, kind: event.kind, phase: "running" });
        }
      } else if (event.event === "step.attached-process.ready") {
        ready = true;
        if (event.stepId) {
          const previous = steps.get(event.stepId);
          steps.set(event.stepId, { id: event.stepId, kind: previous?.kind, phase: "ready" });
        }
      } else if (event.event === "step.end") {
        done = true;
        failed = event.ok === false;
        if (event.stepId) {
          const previous = steps.get(event.stepId);
          steps.set(event.stepId, {
            id: event.stepId,
            kind: previous?.kind ?? event.kind,
            phase: event.ok === false ? "failed" : "succeeded",
            ok: event.ok,
          });
        }
      } else if (event.event === "run.end" || event.event === "plan.end") {
        done = true;
        failed = event.ok === false || failed;
      } else if (event.event?.includes(".fail")) {
        failed = true;
      }
    } catch {
      continue;
    }
  }
  const stepList = [...steps.values()];
  if (failed) {
    return { status: { phase: "failed", currentStepId, currentStepKind, done: true, ready, detail: logSummary.lastFatalDetail ?? `last event: ${lastEvent || "unknown"}` }, steps: stepList };
  }
  if (done) {
    return { status: { phase: "done", currentStepId, currentStepKind, done: true, ready, detail: `last event: ${lastEvent || "unknown"}` }, steps: stepList };
  }
  if (ready) {
    return { status: { phase: "ready", currentStepId, currentStepKind, done: false, ready: true, detail: `current step ${currentStepId ?? "unknown"} is ready and still running` }, steps: stepList };
  }
  if (currentStepId) {
    return {
      status: {
        phase: "starting",
        currentStepId,
        currentStepKind,
        done: false,
        ready: false,
        detail: logSummary.lastProgress
          ? `current step ${currentStepId} is still starting. Latest child progress: ${logSummary.lastProgress}`
          : `current step ${currentStepId} has started and is not ready yet`,
      },
      steps: stepList,
    };
  }
  return { status: { phase: "running", done: false, ready: false, detail: "process is alive" }, steps: stepList };
}

function summarizeLog(rawLog: string | undefined): LogSummary {
  const summary: LogSummary = { lastEvent: "" };
  for (const line of (rawLog ?? "").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const event = JSON.parse(line) as {
        event?: string;
        reason?: string;
        detail?: unknown;
        error?: string;
        line?: string;
        ok?: boolean;
      };
      summary.lastEvent = event.event ?? summary.lastEvent;
      if (typeof event.line === "string") {
        const progress = extractProgressLine(event.line);
        if (progress) {
          summary.lastProgress = progress;
        }
      }
      const fatal = fatalDetail(event);
      if (fatal) {
        summary.lastFatalDetail = fatal;
      }
    } catch {
      continue;
    }
  }
  return summary;
}

function fatalDetail(event: {
  event?: string;
  reason?: string;
  detail?: unknown;
  error?: string;
  ok?: boolean;
}): string | undefined {
  if (event.event === "plan.load-error" || event.event === "bindings.load-error") {
    return `${event.event}: ${event.reason ?? stringifyDetail(event.detail)}`;
  }
  if (event.event === "bindings.validation-error") {
    return `${event.event}: ${stringifyDetail(event.detail)}`;
  }
  if (event.event === "step.attached-process.fail") {
    return `${event.event}: ${event.error ?? stringifyDetail(event.detail)}`;
  }
  if ((event.event === "run.end" || event.event === "plan.end" || event.event === "step.end") && event.ok === false) {
    return `${event.event}: failed`;
  }
  return undefined;
}

function stringifyDetail(detail: unknown): string {
  if (typeof detail === "string") {
    return detail;
  }
  if (detail === undefined) {
    return "unknown";
  }
  return JSON.stringify(detail);
}

function extractProgressLine(line: string): string | undefined {
  const sync = line.match(/sync\s*\[\d+\/\d+\]/i);
  if (sync) {
    return sync[0];
  }
  if (line.includes("Press CTRL-C to stop")) {
    return "Press CTRL-C to stop";
  }
  return undefined;
}

export interface StatusRegistryEntry {
  name: string;
  pid: number;
  alive: boolean;
  envKind: string;
  planName: string;
  planPath: string;
  cwd: string;
  registeredAt: string;
  status: StatusLifecycle;
  steps: StatusStepSummary[];
  logs: {
    run: { path?: string; exists: boolean };
    transcript?: { path?: string; exists: boolean };
  };
}

async function enrichEntry(e: RegistryEntry): Promise<StatusRegistryEntry> {
  const log = await readTail(e.logFile);
  const transcript = await readTail(e.evidence?.transcriptFile);
  const alive = isProcessAlive(e.pid);
  const summarized = summarizeLifecycle(e, alive, log.raw);
  return {
    name: e.name,
    pid: e.pid,
    alive,
    envKind: e.envKind,
    planName: e.planName,
    planPath: e.planPath,
    cwd: e.cwd,
    registeredAt: e.registeredAt,
    status: summarized.status,
    steps: summarized.steps,
    logs: {
      run: { path: log.path, exists: log.exists },
      ...(e.evidence?.transcriptFile ? { transcript: { path: transcript.path, exists: transcript.exists } } : {}),
    },
  };
}

export async function getStatusRegistryEntries(opts: {
  env: Env;
  names?: string[];
}): Promise<StatusRegistryEntry[]> {
  const store = createRegistryStore({ env: opts.env });
  const file = await store.read();
  const all = Object.values(file.entries);
  const names = new Set(opts.names ?? []);
  const filtered = names.size > 0 ? all.filter((entry) => names.has(entry.name)) : all;
  return await Promise.all(filtered.map((entry) => enrichEntry(entry)));
}

export async function runStatusCommand(opts: StatusCommandOptions): Promise<BankaiEnvelope> {
  const env = opts.env ?? createNodeEnv();
  const repoRoot = resolveRepoRoot({ env, override: opts.repoRoot });
  const startedAt = env.clock.isoNow();
  const startedNow = env.clock.now();
  const logger = createRunLogger({
    env,
    command: "status",
    logsDir: opts.logDir ?? defaultBankaiLogsDir(env),
    logFile: opts.logFile,
    planName: opts.name,
  });
  logger.emit("status.start", { name: opts.name, repoRoot });
  const enriched = await getStatusRegistryEntries({ env, names: opts.name ? [opts.name] : undefined });
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
