import { open, mkdir, readFile, unlink, stat, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Env } from "../env-runtime/env.js";
import { RegistryFileSchema, type RegistryFile, type RegistryEntry } from "./types.js";

// Per-user registry of persisted handles. One file at
// <env.home>/.bankai/state/registry.json holds entries keyed by the
// user-chosen registerAs name from setup steps.
//
// Invariants the next editor must preserve:
//   1. ALL writes go through withLock. The lock file is opened with
//      O_EXCL which is atomic on POSIX and Windows. Concurrent bankai
//      invocations across different plans coordinate through this single
//      lock.
//   2. Lock files store the holder pid. Stale-pid detection probes via
//      process.kill(pid, 0). Only ESRCH counts as dead. EPERM is alive.
//   3. read() is unlocked. Status queries tolerate a momentarily stale
//      snapshot. Atomic rename ensures no torn read.
//   4. State writes are atomic via write-tmp + rename. Same filesystem.
//   5. NEVER persist secrets, full env, or cwd-relative paths that could
//      mean different things to a different bankai run. planPath is
//      captured as absolute at registration time.

const DEFAULT_LOCK_RETRIES = 30;
const DEFAULT_LOCK_RETRY_DELAY_MS = 100;
const STALE_LOCK_AGE_MS = 60_000;
const REGISTRY_FILE_REL = ".bankai/state/registry.json";
const REGISTRY_LOCK_REL = ".bankai/state/registry.lock";

export interface CreateRegistryStoreOptions {
  env: Env;
  /** Override the base directory under which .bankai/state lives. Defaults to env.home. Tests inject a tmpdir. */
  baseDir?: string;
  lockRetries?: number;
  lockRetryDelayMs?: number;
}

export interface RegistryMutation<T> {
  next: RegistryFile;
  result: T;
}

export interface RegistryStore {
  readonly registryFilePath: string;
  readonly lockFilePath: string;
  read(): Promise<RegistryFile>;
  withLock<T>(fn: (current: RegistryFile) => Promise<RegistryMutation<T>>): Promise<T>;
  getEntry(name: string): Promise<RegistryEntry | undefined>;
  removeEntry(name: string): Promise<RegistryEntry | undefined>;
  putEntry(entry: RegistryEntry): Promise<void>;
}

const EMPTY_FILE: RegistryFile = { schemaVersion: "1", entries: {} };

async function readRegistryFile(path: string): Promise<RegistryFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return EMPTY_FILE;
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`registry file ${path} is not valid JSON: ${(err as Error).message}`);
  }
  const result = RegistryFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `registry file ${path} failed schema validation: ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
}

async function writeRegistryFileAtomic(path: string, contents: RegistryFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(JSON.stringify(contents, null, 2) + "\n", "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") {
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
  let existingPid: number | undefined;
  try {
    const raw = await readFile(lockPath, "utf8");
    existingPid = parseInt(raw.trim(), 10);
    if (!Number.isFinite(existingPid) || existingPid <= 0) {
      existingPid = undefined;
    }
  } catch {
    // opaque lock
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
      // another process beat us to cleanup
    }
    return { acquired: false, staleHolderPid: existingPid };
  }
  return { acquired: false, existingPid };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createRegistryStore(opts: CreateRegistryStoreOptions): RegistryStore {
  const baseDir = opts.baseDir ?? opts.env.home;
  const registryFilePath = join(baseDir, REGISTRY_FILE_REL);
  const lockFilePath = join(baseDir, REGISTRY_LOCK_REL);
  const retries = opts.lockRetries ?? DEFAULT_LOCK_RETRIES;
  const delayMs = opts.lockRetryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS;

  async function read(): Promise<RegistryFile> {
    return readRegistryFile(registryFilePath);
  }

  async function withLock<T>(
    fn: (current: RegistryFile) => Promise<RegistryMutation<T>>,
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
          ? `bankai registry lock held by pid ${r.existingPid}`
          : `bankai registry lock contended (lockfile ${lockFilePath})`,
      );
      await delay(delayMs);
    }
    if (!acquired) {
      throw attemptError ?? new Error(`could not acquire bankai registry lock at ${lockFilePath}`);
    }
    try {
      const current = await read();
      const { next, result } = await fn(current);
      const validated = RegistryFileSchema.parse(next);
      await writeRegistryFileAtomic(registryFilePath, validated);
      return result;
    } finally {
      try {
        await unlink(lockFilePath);
      } catch {
        // lock may have been removed by stale-detection in another process
      }
    }
  }

  async function getEntry(name: string): Promise<RegistryEntry | undefined> {
    const file = await read();
    return file.entries[name];
  }

  async function removeEntry(name: string): Promise<RegistryEntry | undefined> {
    return withLock<RegistryEntry | undefined>(async (current) => {
      const removed = current.entries[name];
      if (!removed) {
        return { next: current, result: undefined };
      }
      const nextEntries = { ...current.entries };
      delete nextEntries[name];
      return { next: { ...current, entries: nextEntries }, result: removed };
    });
  }

  async function putEntry(entry: RegistryEntry): Promise<void> {
    return withLock<void>(async (current) => {
      const nextEntries = { ...current.entries, [entry.name]: entry };
      return { next: { ...current, entries: nextEntries }, result: undefined };
    });
  }

  return {
    registryFilePath,
    lockFilePath,
    read,
    withLock,
    getEntry,
    removeEntry,
    putEntry,
  };
}
