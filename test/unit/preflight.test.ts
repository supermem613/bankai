import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeEnv, type Env } from "../../src/env-runtime/env.js";
import { createRegistryStore, type RegistryStore } from "../../src/registry/store.js";
import type { ProcessFingerprint, RegistryEntry } from "../../src/registry/types.js";
import { captureFingerprint } from "../../src/fingerprint.js";
import {
  checkRegisteredAlive,
  formatAlreadyRunningMessage,
} from "../../src/registry/preflight.js";

// Tests use process.pid as the canonical alive pid and a sentinel low
// number (1 is init/launchd/system on every supported OS and is safe to
// probe with `kill 0`; the test never SENDS a signal, only checks
// liveness). They never touch the real ~/.bankai because run.mjs
// sandboxes HOME/USERPROFILE to a tmpdir.

const DEAD_PID_PROBE_GUESSES = [99999, 99998, 99997, 99996, 99995];

async function findDeadPid(): Promise<number> {
  for (const candidate of DEAD_PID_PROBE_GUESSES) {
    try {
      process.kill(candidate, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") {
        return candidate;
      }
    }
  }
  throw new Error("could not find a dead pid for the test");
}

function baseEntry(overrides: Partial<RegistryEntry>): RegistryEntry {
  return {
    name: "svc",
    planName: "p",
    planPath: "/abs/p.json",
    cwd: "/abs",
    envKind: "attached-process",
    registeredAt: "2025-01-01T00:00:00.000Z",
    pid: process.pid,
    command: "node",
    args: ["server.js"],
    workDir: "/abs",
    logFile: "/abs/log.txt",
    logStartOffset: 0,
    ...overrides,
  };
}

describe("registry/preflight: checkRegisteredAlive", () => {
  let tmp: string;
  let env: Env;
  let registry: RegistryStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "bankai-preflight-"));
    env = createNodeEnv();
    registry = createRegistryStore({ env, baseDir: tmp });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns none when the name has no entry", async () => {
    const result = await checkRegisteredAlive({ env, registry, name: "missing" });
    assert.equal(result.kind, "none");
  });

  it("returns stale when the recorded pid is dead", async () => {
    const deadPid = await findDeadPid();
    await registry.putEntry(baseEntry({ name: "dead", pid: deadPid }));
    const result = await checkRegisteredAlive({ env, registry, name: "dead" });
    assert.equal(result.kind, "stale");
    if (result.kind === "stale") {
      assert.equal(result.entry.pid, deadPid);
      assert.match(result.reason, /not alive/);
    }
  });

  it("returns stale when the pid is alive but the entry has no recorded fingerprint", async () => {
    await registry.putEntry(baseEntry({ name: "no-fp", pid: process.pid }));
    const result = await checkRegisteredAlive({ env, registry, name: "no-fp" });
    assert.equal(result.kind, "stale");
    if (result.kind === "stale") {
      assert.match(result.reason, /no recorded fingerprint/);
    }
  });

  it("returns stale when the pid is alive but the recorded fingerprint mismatches", async () => {
    const synthetic: ProcessFingerprint = {
      creationTime: "synthetic-creation-time-that-cannot-match-any-real-process",
      commandLine: "synthetic command line",
    };
    await registry.putEntry(baseEntry({ name: "mismatch", pid: process.pid, fingerprint: synthetic }));
    const result = await checkRegisteredAlive({ env, registry, name: "mismatch" });
    // Some platforms cannot capture a fingerprint (e.g. unknown platform);
    // verifyFingerprint then returns matches:false with "could not capture"
    // detail, which still classifies as stale. Either branch is acceptable.
    assert.equal(result.kind, "stale");
  });

  it("returns alive when the pid is alive and the recorded fingerprint matches", async () => {
    const fp = await captureFingerprint({ pid: process.pid, env });
    if (!fp) {
      // captureFingerprint is best-effort and may return undefined on
      // exotic platforms or sandboxed CI hosts. Skip the positive case
      // there because we cannot construct a matching fingerprint.
      return;
    }
    await registry.putEntry(baseEntry({ name: "alive", pid: process.pid, fingerprint: fp }));
    const result = await checkRegisteredAlive({ env, registry, name: "alive" });
    assert.equal(result.kind, "alive");
    if (result.kind === "alive") {
      assert.equal(result.entry.pid, process.pid);
      assert.match(result.reason, /fingerprint matches/);
    }
  });
});

describe("registry/preflight: formatAlreadyRunningMessage", () => {
  it("includes the name, pid, registration timestamp, planPath, and bankai stop hint", () => {
    const entry = baseEntry({
      name: "augloop-workflows",
      pid: 12345,
      registeredAt: "2026-05-26T18:00:00.000Z",
      planPath: "/repos/x/augloop-workflows.dev-loop.json",
    });
    const msg = formatAlreadyRunningMessage({ name: "augloop-workflows", entry });
    assert.match(msg, /augloop-workflows/);
    assert.match(msg, /12345/);
    assert.match(msg, /2026-05-26T18:00:00\.000Z/);
    assert.match(msg, /augloop-workflows\.dev-loop\.json/);
    assert.match(msg, /bankai stop augloop-workflows/);
  });
});
