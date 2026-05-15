import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeEnv } from "../../src/env-runtime/env.js";
import { createStateStore } from "../../src/dev-loop/state.js";
import type { DevLoopStateEntry } from "../../src/dev-loop/envelope.js";

function makeRepo(): string {
  return mkdtempSync(join(tmpdir(), "bankai-state-"));
}

function makeEntry(planName: string, pid = 12345): DevLoopStateEntry {
  return {
    schemaVersion: "1",
    planName,
    startedAt: "2024-01-01T00:00:00.000Z",
    pid,
    fingerprint: { creationTime: "fake", commandLine: "node script.js" },
    workDir: "/tmp/work",
    command: "node",
    args: ["script.js"],
    logFile: "/tmp/work/dev.log",
    logStartOffset: 0,
    envKind: "managed-process",
  };
}

test("state: read on a fresh repo returns empty file", async () => {
  const repo = makeRepo();
  try {
    const store = createStateStore({ repoRoot: repo, env: createNodeEnv() });
    const file = await store.read();
    assert.equal(file.schemaVersion, "1");
    assert.deepEqual(file.entries, {});
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("state: putEntry persists, getEntry returns it, removeEntry deletes", async () => {
  const repo = makeRepo();
  try {
    const store = createStateStore({ repoRoot: repo, env: createNodeEnv() });
    await store.putEntry(makeEntry("plan-a"));
    const fetched = await store.getEntry("plan-a");
    assert.ok(fetched);
    assert.equal(fetched?.planName, "plan-a");
    assert.equal(existsSync(store.stateFilePath), true);

    const removed = await store.removeEntry("plan-a");
    assert.equal(removed?.planName, "plan-a");
    const after = await store.getEntry("plan-a");
    assert.equal(after, undefined);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("state: putEntry stores multiple plans without clobbering each other", async () => {
  const repo = makeRepo();
  try {
    const store = createStateStore({ repoRoot: repo, env: createNodeEnv() });
    await store.putEntry(makeEntry("alpha", 100));
    await store.putEntry(makeEntry("beta", 200));
    const a = await store.getEntry("alpha");
    const b = await store.getEntry("beta");
    assert.equal(a?.pid, 100);
    assert.equal(b?.pid, 200);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("state: removeEntry on missing plan returns undefined and leaves file intact", async () => {
  const repo = makeRepo();
  try {
    const store = createStateStore({ repoRoot: repo, env: createNodeEnv() });
    await store.putEntry(makeEntry("alpha", 100));
    const result = await store.removeEntry("not-there");
    assert.equal(result, undefined);
    const a = await store.getEntry("alpha");
    assert.equal(a?.pid, 100);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("state: rejects garbage state file content with a clear error", async () => {
  const repo = makeRepo();
  try {
    const store = createStateStore({ repoRoot: repo, env: createNodeEnv() });
    mkdirSync(join(repo, ".bankai", "state"), { recursive: true });
    writeFileSync(store.stateFilePath, "{not-json", "utf8");
    await assert.rejects(() => store.read(), /not valid JSON/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("state: rejects schema-invalid state file with a clear error", async () => {
  const repo = makeRepo();
  try {
    const store = createStateStore({ repoRoot: repo, env: createNodeEnv() });
    mkdirSync(join(repo, ".bankai", "state"), { recursive: true });
    writeFileSync(store.stateFilePath, JSON.stringify({ schemaVersion: "9" }), "utf8");
    await assert.rejects(() => store.read(), /schema validation/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("state: stale lock from dead pid is broken and acquired", async () => {
  const repo = makeRepo();
  try {
    const store = createStateStore({
      repoRoot: repo,
      env: createNodeEnv(),
      lockRetries: 5,
      lockRetryDelayMs: 20,
    });
    // Plant a stale lock with a pid that cannot exist (max + 1).
    mkdirSync(join(repo, ".bankai", "state"), { recursive: true });
    writeFileSync(store.lockFilePath, "2147483647", "utf8");
    await store.putEntry(makeEntry("alpha"));
    const a = await store.getEntry("alpha");
    assert.equal(a?.planName, "alpha");
    assert.equal(existsSync(store.lockFilePath), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("state: live lock blocks acquisition until released", async () => {
  const repo = makeRepo();
  try {
    const store = createStateStore({
      repoRoot: repo,
      env: createNodeEnv(),
      lockRetries: 100,
      lockRetryDelayMs: 10,
    });
    // Hold the lock manually with our own (live) pid.
    mkdirSync(join(repo, ".bankai", "state"), { recursive: true });
    writeFileSync(store.lockFilePath, String(process.pid), "utf8");

    const acquirePromise = store.putEntry(makeEntry("alpha"));
    let resolved = false;
    acquirePromise.then(() => {
      resolved = true;
    });
    // Wait briefly. The acquirer should still be waiting because we hold the lock.
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(resolved, false);
    // Release: simulate the lock holder finishing.
    rmSync(store.lockFilePath, { force: true });
    await acquirePromise;
    const a = await store.getEntry("alpha");
    assert.equal(a?.planName, "alpha");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("state: gives up with a clear error when contention exceeds retries", async () => {
  const repo = makeRepo();
  try {
    const store = createStateStore({
      repoRoot: repo,
      env: createNodeEnv(),
      lockRetries: 3,
      lockRetryDelayMs: 5,
    });
    mkdirSync(join(repo, ".bankai", "state"), { recursive: true });
    writeFileSync(store.lockFilePath, String(process.pid), "utf8");
    await assert.rejects(() => store.putEntry(makeEntry("alpha")), /lock/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("state: writes are atomic (file always parses successfully)", async () => {
  const repo = makeRepo();
  try {
    const store = createStateStore({ repoRoot: repo, env: createNodeEnv() });
    await store.putEntry(makeEntry("alpha"));
    const raw = readFileSync(store.stateFilePath, "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.schemaVersion, "1");
    assert.ok(parsed.entries.alpha);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("state: NEVER persists secrets such as env or fullConfig", async () => {
  const repo = makeRepo();
  try {
    const store = createStateStore({ repoRoot: repo, env: createNodeEnv() });
    await store.putEntry(makeEntry("alpha"));
    const raw = readFileSync(store.stateFilePath, "utf8");
    // Schema enforces this at type level; this guards against future schema
    // drift that might add a leak.
    assert.equal(raw.includes("\"env\""), false);
    assert.equal(raw.toLowerCase().includes("secret"), false);
    assert.equal(raw.toLowerCase().includes("token"), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
