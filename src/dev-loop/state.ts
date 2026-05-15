import { open, mkdir, readFile, unlink, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Env } from "../env-runtime/env.js";
import { DevLoopStateFileSchema, type DevLoopStateFile, type DevLoopStateEntry } from "./envelope.js";

// Dev-loop state store. One state file per repo at
// <repo>/.bankai/state/dev-loop.json holds entries keyed by plan name.
// Invariants the next editor must preserve:
//   1. ALL writes go through withLock so concurrent bankai dev-loop
//      invocations cannot corrupt the file or race two starts of the
//      same plan. The lock file is opened with O_EXCL; this is atomic
//      on POSIX and Windows.
//   2. Lock files store the holder pid. If a stale lock blocks an
//      acquire, we read the pid, probe liveness via process.kill(pid, 0),
//      and unlink only if the holder is dead. Never unlink a live lock.
//   3. read() is unlocked. It is for status queries that tolerate a
//      momentarily stale snapshot. State writes happen only inside
//      withLock, so a read interleaved with a write either sees the old
//      file or the atomic-rename new file. There is no torn read.
//   4. State writes are atomic via write-tmp + rename. NEVER write
//      directly to the destination path; a crash mid-write would leave
//      garbage that fails schema validation.
//   5. State NEVER persists secrets or full env. Only the operational
//      handle: pid, fingerprint, workDir, command + args (display only),
//      logFile, logStartOffset, envKind. A future env field would be a
//      security regression.

const STATE_FILE_REL = ".bankai/state/dev-loop.json";
const LOCK_FILE_REL = ".bankai/state/dev-loop.lock";
const DEFAULT_LOCK_RETRIES = 30;
const DEFAULT_LOCK_RETRY_DELAY_MS = 100;
const STALE_LOCK_AGE_MS = 60_000;

export interface CreateStateStoreOptions {
  repoRoot: string;
  env: Env;
  lockRetries?: number;
  lockRetryDelayMs?: number;
}

export interface StateMutation<T> {
  next: DevLoopStateFile;
  result: T;
}

export interface StateStore {
  readonly stateFilePath: string;
  readonly lockFilePath: string;
  read(): Promise<DevLoopStateFile>;
  withLock<T>(fn: (current: DevLoopStateFile) => Promise<StateMutation<T>>): Promise<T>;
  getEntry(planName: string): Promise<DevLoopStateEntry | undefined>;
  removeEntry(planName: string): Promise<DevLoopStateEntry | undefined>;
  putEntry(entry: DevLoopStateEntry): Promise<void>;
}

const EMPTY_STATE: DevLoopStateFile = { schemaVersion: "1", entries: {} };

async function readStateFile(path: string): Promise<DevLoopStateFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return EMPTY_STATE;
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`dev-loop state file ${path} is not valid JSON: ${(err as Error).message}`);
  }
  const result = DevLoopStateFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `dev-loop state file ${path} failed schema validation: ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
}

async function writeStateFileAtomic(path: string, contents: DevLoopStateFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(JSON.stringify(contents, null, 2) + "\n", "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  // rename is atomic on the same filesystem.
  await (async () => {
    const { rename } = await import("node:fs/promises");
    await rename(tmp, path);
  })();
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") {
      // Process exists but we lack permission to signal. Treat as alive.
      return true;
    }
    return false;
  }
}

async function tryAcquireLock(
  lockPath: string,
  ownerPid: number,
): Promise<{ acquired: boolean; staleHolderPid?: number; existingPid?: number }> {
  await mkdir(dirname(lockPath), { recursive: true });
  try {
    const fh = await open(lockPath, "wx");
    try {
      await fh.writeFile(String(ownerPid), "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    return { acquired: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err;
    }
  }
  // Lock exists. Inspect for staleness.
  let existingPid: number | undefined;
  try {
    const raw = await readFile(lockPath, "utf8");
    existingPid = parseInt(raw.trim(), 10);
    if (!Number.isFinite(existingPid) || existingPid <= 0) {
      existingPid = undefined;
    }
  } catch {
    // Could not read; treat as opaque lock.
  }
  let stale = false;
  if (existingPid && !isAlive(existingPid)) {
    stale = true;
  } else {
    try {
      const s = await stat(lockPath);
      if (Date.now() - s.mtimeMs > STALE_LOCK_AGE_MS && (!existingPid || !isAlive(existingPid))) {
        stale = true;
      }
    } catch {
      // ignore
    }
  }
  if (stale) {
    try {
      await unlink(lockPath);
    } catch {
      // Another process beat us to cleanup; that is fine.
    }
    return { acquired: false, staleHolderPid: existingPid };
  }
  return { acquired: false, existingPid };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createStateStore(opts: CreateStateStoreOptions): StateStore {
  const stateFilePath = join(opts.repoRoot, STATE_FILE_REL);
  const lockFilePath = join(opts.repoRoot, LOCK_FILE_REL);
  const retries = opts.lockRetries ?? DEFAULT_LOCK_RETRIES;
  const delayMs = opts.lockRetryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS;

  async function read(): Promise<DevLoopStateFile> {
    return readStateFile(stateFilePath);
  }

  async function withLock<T>(
    fn: (current: DevLoopStateFile) => Promise<StateMutation<T>>,
  ): Promise<T> {
    let acquired = false;
    let attemptError: Error | undefined;
    for (let attempt = 0; attempt < retries; attempt++) {
      const r = await tryAcquireLock(lockFilePath, process.pid);
      if (r.acquired) {
        acquired = true;
        break;
      }
      attemptError = new Error(
        r.existingPid
          ? `dev-loop state lock held by pid ${r.existingPid}`
          : `dev-loop state lock contended (lockfile ${lockFilePath})`,
      );
      await delay(delayMs);
    }
    if (!acquired) {
      throw attemptError ?? new Error(`could not acquire dev-loop state lock at ${lockFilePath}`);
    }
    try {
      const current = await read();
      const { next, result } = await fn(current);
      const validated = DevLoopStateFileSchema.parse(next);
      await writeStateFileAtomic(stateFilePath, validated);
      return result;
    } finally {
      try {
        await unlink(lockFilePath);
      } catch {
        // Lock may have been removed by stale-detection in another process.
      }
    }
  }

  async function getEntry(planName: string): Promise<DevLoopStateEntry | undefined> {
    const file = await read();
    return file.entries[planName];
  }

  async function removeEntry(planName: string): Promise<DevLoopStateEntry | undefined> {
    return withLock(async (current) => {
      const removed = current.entries[planName];
      if (!removed) {
        return { next: current, result: undefined };
      }
      const nextEntries = { ...current.entries };
      delete nextEntries[planName];
      return {
        next: { ...current, entries: nextEntries },
        result: removed,
      };
    });
  }

  async function putEntry(entry: DevLoopStateEntry): Promise<void> {
    return withLock(async (current) => {
      const nextEntries = { ...current.entries, [entry.planName]: entry };
      return {
        next: { ...current, entries: nextEntries },
        result: undefined,
      };
    });
  }

  return {
    stateFilePath,
    lockFilePath,
    read,
    withLock,
    getEntry,
    removeEntry,
    putEntry,
  };
}
