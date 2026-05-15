import { promises as fsp, openSync, closeSync } from "node:fs";
import { join } from "node:path";

// FileStateStore: durable iteration state for a single plan run. Invariants
// the next editor must preserve:
//   1. writeAtomic must NEVER mutate the final file in place. It writes to a
//      tmp sibling, fsyncs, then renames. This is what survives mid-write
//      crashes so a previous-good state is always readable on resume.
//   2. acquireLock must use O_EXCL semantics. Two concurrent CLI invocations
//      against the same plan must not both believe they hold the lock.
//   3. read must tolerate a junk tmp sibling left behind by a crashed prior
//      writer and must not surface it as the current state.
//   4. The on-disk layout is stable contract. State at <dir>/<name>.json,
//      tmp at <dir>/<name>.json.tmp, lock at <dir>/<name>.lock. External
//      tooling and recovery scripts may depend on these paths.

export interface FileStateStoreOptions {
  dir: string;
  name: string;
}

export class FileStateStore<T = unknown> {
  private readonly statePath: string;
  private readonly tmpPath: string;
  private readonly lockPath: string;

  constructor(opts: FileStateStoreOptions) {
    this.statePath = join(opts.dir, `${opts.name}.json`);
    this.tmpPath = join(opts.dir, `${opts.name}.json.tmp`);
    this.lockPath = join(opts.dir, `${opts.name}.lock`);
  }

  async writeAtomic(state: T): Promise<void> {
    const data = JSON.stringify(state, null, 2);
    const fh = await fsp.open(this.tmpPath, "w");
    try {
      await fh.writeFile(data, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    // fsp.rename atomically replaces the destination on Windows in Node 18+
    // and on POSIX since forever. This is the moment the new state becomes
    // visible to readers. Anything that throws before this leaves the prior
    // state untouched.
    await fsp.rename(this.tmpPath, this.statePath);
  }

  async read(): Promise<T | undefined> {
    try {
      const raw = await fsp.readFile(this.statePath, "utf8");
      return JSON.parse(raw) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw err;
    }
  }

  async acquireLock(): Promise<void> {
    // openSync with the "wx" flag is O_CREAT|O_EXCL|O_WRONLY. EEXIST is the
    // signal that another process holds the lock. v1 hard-fails on EEXIST.
    // Stale-lock recovery via PID liveness check is a separate task.
    try {
      const fd = openSync(this.lockPath, "wx");
      closeSync(fd);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`lock already held: ${this.lockPath}`);
      }
      throw err;
    }
  }

  async releaseLock(): Promise<void> {
    try {
      await fsp.unlink(this.lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw err;
    }
  }
}
