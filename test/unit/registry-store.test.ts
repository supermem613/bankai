import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeEnv, type Env } from "../../src/env-runtime/env.js";
import { createRegistryStore, type RegistryStore } from "../../src/registry/store.js";
import type { RegistryEntry } from "../../src/registry/types.js";

// Tests use process.execPath as the canonical alive pid (the test runner
// itself). They never touch the real ~/.bankai because run.mjs sandboxes
// HOME/USERPROFILE to a tmpdir.

function makeEntry(name: string, pid: number, planName = "p"): RegistryEntry {
  return {
    name,
    planName,
    planPath: "/abs/p.json",
    cwd: "/abs",
    envKind: "managed-process",
    registeredAt: "2025-01-01T00:00:00.000Z",
    pid,
    command: "node",
    args: ["server.js"],
    workDir: "/abs",
    logFile: "/abs/log.txt",
    logStartOffset: 0,
  };
}

describe("registry/store", () => {
  let tmp: string;
  let env: Env;
  let store: RegistryStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "bankai-registry-"));
    env = createNodeEnv();
    store = createRegistryStore({ env, baseDir: tmp });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("read returns empty file when nothing has been written", async () => {
    const file = await store.read();
    assert.equal(file.schemaVersion, "1");
    assert.deepEqual(file.entries, {});
  });

  it("registry path is per-user under baseDir", () => {
    assert.equal(store.registryFilePath, join(tmp, ".bankai/state/registry.json"));
    assert.equal(store.lockFilePath, join(tmp, ".bankai/state/registry.lock"));
  });

  it("putEntry writes through withLock and survives a reload", async () => {
    const entry = makeEntry("svc", process.pid);
    await store.putEntry(entry);
    const reread = await store.read();
    assert.equal(reread.entries.svc?.pid, process.pid);
  });

  it("putEntry persists JSON in a parseable form on disk", async () => {
    await store.putEntry(makeEntry("svc", process.pid));
    const raw = readFileSync(store.registryFilePath, "utf8");
    const parsed = JSON.parse(raw) as { entries: Record<string, RegistryEntry> };
    assert.equal(parsed.entries.svc?.name, "svc");
  });

  it("removeEntry returns the removed entry and leaves others untouched", async () => {
    await store.putEntry(makeEntry("a", process.pid));
    await store.putEntry(makeEntry("b", process.pid));
    const removed = await store.removeEntry("a");
    assert.equal(removed?.name, "a");
    const remaining = await store.read();
    assert.equal(remaining.entries.a, undefined);
    assert.ok(remaining.entries.b);
  });

  it("removeEntry on a missing name returns undefined and is a no-op", async () => {
    const r = await store.removeEntry("not-there");
    assert.equal(r, undefined);
  });

  it("withLock serializes mutations against itself", async () => {
    const order: string[] = [];
    await Promise.all([
      store.withLock<void>(async (cur) => {
        order.push("a-start");
        await new Promise((r) => setTimeout(r, 50));
        order.push("a-end");
        return { next: cur, result: undefined };
      }),
      store.withLock<void>(async (cur) => {
        order.push("b-start");
        order.push("b-end");
        return { next: cur, result: undefined };
      }),
    ]);
    // a-start and a-end must be adjacent.
    const ai = order.indexOf("a-start");
    assert.equal(order[ai + 1], "a-end");
  });
});
