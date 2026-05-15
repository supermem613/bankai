import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeEnv } from "../../src/env-runtime/env.js";
import { logLineMatchesProbe } from "../../src/dev-loop/readiness/log-line-matches.js";
import type { DevLoopStateEntry } from "../../src/dev-loop/envelope.js";

function makeState(logFile: string, logStartOffset = 0): DevLoopStateEntry {
  return {
    schemaVersion: "1",
    planName: "x",
    startedAt: "2024-01-01T00:00:00.000Z",
    pid: 1,
    fingerprint: { creationTime: "x", commandLine: "y" },
    workDir: "/tmp",
    command: "node",
    args: [],
    logFile,
    logStartOffset,
    envKind: "managed-process",
  };
}

test("log-line-matches: ok=true when pattern matches a line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bankai-log-"));
  try {
    const log = join(dir, "dev.log");
    writeFileSync(log, "starting up\nListening on http://127.0.0.1:8080\nready\n");
    const env = createNodeEnv();
    const ctrl = new AbortController();
    const r = await logLineMatchesProbe.evaluate(
      { env, state: makeState(log), signal: ctrl.signal },
      { kind: "log-line-matches", id: "l", pattern: "Listening on .+:\\d+", flags: "", maxBytes: 1_048_576 },
    );
    assert.equal(r.ok, true, r.detail);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("log-line-matches: ok=false when pattern is absent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bankai-log-"));
  try {
    const log = join(dir, "dev.log");
    writeFileSync(log, "still warming up\n");
    const env = createNodeEnv();
    const ctrl = new AbortController();
    const r = await logLineMatchesProbe.evaluate(
      { env, state: makeState(log), signal: ctrl.signal },
      { kind: "log-line-matches", id: "l", pattern: "Listening", flags: "", maxBytes: 1_048_576 },
    );
    assert.equal(r.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("log-line-matches: scans only from logStartOffset, ignoring earlier matches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bankai-log-"));
  try {
    const log = join(dir, "dev.log");
    const stale = "Listening on prior run\n";
    const fresh = "still booting\nstill booting\n";
    writeFileSync(log, stale + fresh);
    const env = createNodeEnv();
    const ctrl = new AbortController();
    const r = await logLineMatchesProbe.evaluate(
      { env, state: makeState(log, Buffer.byteLength(stale)), signal: ctrl.signal },
      { kind: "log-line-matches", id: "l", pattern: "Listening", flags: "", maxBytes: 1_048_576 },
    );
    assert.equal(r.ok, false, `should ignore earlier match: ${r.detail}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("log-line-matches: ok=false when log file does not exist yet", async () => {
  const env = createNodeEnv();
  const ctrl = new AbortController();
  const r = await logLineMatchesProbe.evaluate(
    { env, state: makeState("C:/this/does/not/exist/" + Date.now() + ".log"), signal: ctrl.signal },
    { kind: "log-line-matches", id: "l", pattern: "Listening", flags: "", maxBytes: 1024 },
  );
  assert.equal(r.ok, false);
  assert.match(r.detail, /not found yet/);
});

test("log-line-matches: caps scan at maxBytes (only the tail is read)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bankai-log-"));
  try {
    const log = join(dir, "dev.log");
    // Write a "stale" first segment that contains the pattern, then a
    // huge filler region, then the tail with the desired match.
    const filler = "x".repeat(2048);
    writeFileSync(log, "Listening near the start\n" + filler + "\nReadyMarker found\n");
    const env = createNodeEnv();
    const ctrl = new AbortController();
    // maxBytes deliberately smaller than the total file. Tail-window
    // means only the last maxBytes bytes are scanned, so the early
    // "Listening" should not be seen.
    const r = await logLineMatchesProbe.evaluate(
      { env, state: makeState(log, 0), signal: ctrl.signal },
      { kind: "log-line-matches", id: "l", pattern: "Listening near the start", flags: "", maxBytes: 1024 },
    );
    assert.equal(r.ok, false, `tail window should miss the early match: ${r.detail}`);
    const r2 = await logLineMatchesProbe.evaluate(
      { env, state: makeState(log, 0), signal: ctrl.signal },
      { kind: "log-line-matches", id: "l", pattern: "ReadyMarker", flags: "", maxBytes: 1024 },
    );
    assert.equal(r2.ok, true, `tail window should hit the late match: ${r2.detail}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("log-line-matches: invalid regex reports config error, not a throw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bankai-log-"));
  try {
    const log = join(dir, "dev.log");
    writeFileSync(log, "anything\n");
    const env = createNodeEnv();
    const ctrl = new AbortController();
    const r = await logLineMatchesProbe.evaluate(
      { env, state: makeState(log), signal: ctrl.signal },
      { kind: "log-line-matches", id: "l", pattern: "(unclosed", flags: "", maxBytes: 1024 },
    );
    assert.equal(r.ok, false);
    assert.match(r.detail, /invalid regex/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
