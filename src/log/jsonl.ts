import { createWriteStream, type WriteStream } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join, isAbsolute, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { Env } from "../env-runtime/env.js";

// JSONL run logger. Every bankai invocation produces ONE log file with
// one JSON object per line. Events capture step boundaries, shell
// output chunks, readiness probe observations, fingerprint checks, and
// registry mutations. Reading these logs is the canonical way to
// evaluate a run after the fact without re-executing it.
//
// Invariants the next editor must preserve:
//   1. ONE log file per command invocation. Never share across commands.
//      Concurrent bankai invocations get distinct files via runId.
//   2. Lines are atomic. Each emit writes ONE JSON.stringify result plus
//      a trailing newline in a single stream.write call. Node's
//      WriteStream serializes writes to a single fd so there is no torn
//      output even with high event rates.
//   3. emit is fire-and-forget. It NEVER throws. A logger failure must
//      not break the orchestrator. Errors are captured and surfaced
//      via the err getter for end-of-run reporting.
//   4. close() flushes and waits for OS to ack. Callers MUST await
//      close before printing the human summary so the log file is on
//      disk when the user reads it.
//   5. ts is ISO8601 from env.clock.isoNow so tests can inject a
//      deterministic clock. runId is random hex so distinct runs are
//      easy to correlate across files.
//   6. Payloads must be JSON-serializable. The logger does NOT scrub
//      secrets. Callers are responsible for omitting env vars, file
//      contents, and credentials from event payloads.

export interface RunLoggerEvent {
  ts: string;
  runId: string;
  command: string;
  event: string;
  [key: string]: unknown;
}

export interface RunLogger {
  readonly logFilePath: string;
  readonly runId: string;
  readonly command: string;
  emit(event: string, payload?: Record<string, unknown>): void;
  close(): Promise<void>;
  /** Last error emitted by the underlying stream, if any. */
  readonly err: Error | undefined;
}

export interface CreateRunLoggerOptions {
  env: Env;
  command: string;
  logsDir: string;
  planName?: string;
  /** Optional explicit log file path. If set, overrides logsDir + computed filename. */
  logFile?: string;
  /** Optional fixed runId. Tests use this for determinism. */
  runId?: string;
}

export function defaultBankaiLogsDir(env: Env): string {
  return join(env.home, ".bankai", "logs");
}

function shortId(): string {
  return randomBytes(4).toString("hex");
}

function safePart(s: string | undefined): string {
  if (!s) {
    return "unnamed";
  }
  return s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 64) || "unnamed";
}

export function resolveLogFilePath(opts: CreateRunLoggerOptions): string {
  if (opts.logFile) {
    return isAbsolute(opts.logFile) ? opts.logFile : resolve(opts.env.cwd, opts.logFile);
  }
  const ts = opts.env.clock.isoNow().replace(/[:.]/g, "-");
  const planPart = safePart(opts.planName);
  const cmdPart = safePart(opts.command);
  const runId = opts.runId ?? shortId();
  const fname = `${cmdPart}-${planPart}-${ts}-${runId}.jsonl`;
  const dir = isAbsolute(opts.logsDir) ? opts.logsDir : resolve(opts.env.cwd, opts.logsDir);
  return join(dir, fname);
}

export function createRunLogger(opts: CreateRunLoggerOptions): RunLogger {
  const logFilePath = resolveLogFilePath(opts);
  mkdirSync(dirname(logFilePath), { recursive: true });
  const runId = opts.runId ?? extractRunIdFromPath(logFilePath) ?? shortId();
  let stream: WriteStream | undefined = createWriteStream(logFilePath, { flags: "a" });
  let lastErr: Error | undefined;
  stream.on("error", (err) => {
    lastErr = err;
  });

  function emit(event: string, payload?: Record<string, unknown>): void {
    if (!stream) {
      return;
    }
    try {
      const record: RunLoggerEvent = {
        ts: opts.env.clock.isoNow(),
        runId,
        command: opts.command,
        event,
        ...payload,
      };
      stream.write(JSON.stringify(record) + "\n");
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }

  async function close(): Promise<void> {
    if (!stream) {
      return;
    }
    const s = stream;
    stream = undefined;
    await new Promise<void>((resolveDone) => {
      s.end(() => resolveDone());
    });
  }

  return {
    logFilePath,
    runId,
    command: opts.command,
    emit,
    close,
    get err(): Error | undefined {
      return lastErr;
    },
  };
}

function extractRunIdFromPath(logFilePath: string): string | undefined {
  const m = logFilePath.match(/-([0-9a-f]{8})\.jsonl$/);
  return m ? m[1] : undefined;
}

// No-op logger for unit tests that do not care about events.
export function createNoopLogger(command = "noop"): RunLogger {
  return {
    logFilePath: "",
    runId: "noop",
    command,
    emit(): void {},
    async close(): Promise<void> {},
    err: undefined,
  };
}
