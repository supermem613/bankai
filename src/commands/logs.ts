import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createNodeEnv, type Env } from "../env-runtime/env.js";
import { createRunLogger, defaultBankaiLogsDir } from "../log/jsonl.js";
import { resolveRepoRoot } from "../repo-root.js";
import { createRegistryStore } from "../registry/store.js";
import type { BankaiEnvelope } from "../plan/envelope.js";
import type { RegistryEntry } from "../registry/types.js";

export interface LogsCommandOptions {
  name?: string;
  env?: Env;
  logDir?: string;
  logFile?: string;
  repoRoot?: string;
}

const LOG_TAIL_CHARS = 12000;

async function readLog(path: string | undefined): Promise<{ path?: string; exists: boolean; tail?: string; error?: string }> {
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
      tail: raw.length > LOG_TAIL_CHARS ? raw.slice(raw.length - LOG_TAIL_CHARS) : raw,
    };
  } catch (err) {
    return {
      path,
      exists: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function logEntry(entry: RegistryEntry): Promise<{
  name: string;
  pid: number;
  planName: string;
  planPath: string;
  logs: {
    run: { path?: string; exists: boolean; tail?: string; error?: string };
    transcript?: { path?: string; exists: boolean; tail?: string; error?: string };
  };
}> {
  const run = await readLog(entry.logFile);
  const transcript = entry.evidence?.transcriptFile ? await readLog(entry.evidence.transcriptFile) : undefined;
  return {
    name: entry.name,
    pid: entry.pid,
    planName: entry.planName,
    planPath: entry.planPath,
    logs: {
      run,
      ...(transcript ? { transcript } : {}),
    },
  };
}

export async function runLogsCommand(opts: LogsCommandOptions): Promise<BankaiEnvelope> {
  const env = opts.env ?? createNodeEnv();
  const repoRoot = resolveRepoRoot({ env, override: opts.repoRoot });
  const startedAt = env.clock.isoNow();
  const startedNow = env.clock.now();
  const logger = createRunLogger({
    env,
    command: "logs",
    logsDir: opts.logDir ?? defaultBankaiLogsDir(env),
    logFile: opts.logFile,
    planName: opts.name,
  });
  logger.emit("logs.start", { name: opts.name, repoRoot });
  const store = createRegistryStore({ env });
  const file = await store.read();
  const all = Object.values(file.entries);
  const filtered = opts.name ? all.filter((entry) => entry.name === opts.name) : all;
  const entries = await Promise.all(filtered.map(logEntry));
  for (const entry of entries) {
    logger.emit("logs.entry", { name: entry.name, pid: entry.pid, hasRunLog: entry.logs.run.exists });
  }
  const finishedAt = env.clock.isoNow();
  const envelope: BankaiEnvelope = {
    ok: true,
    command: "logs",
    startedAt,
    finishedAt,
    durationMs: env.clock.now() - startedNow,
    runId: logger.runId,
    logFile: logger.logFilePath,
    steps: [],
    registry: entries,
  };
  logger.emit("logs.end", { count: entries.length });
  await logger.close();
  return envelope;
}
