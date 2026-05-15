import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { createNodeEnv } from "../../src/env-runtime/env.js";
import { portReadinessProbe } from "../../src/dev-loop/readiness/port.js";
import type { DevLoopStateEntry } from "../../src/dev-loop/envelope.js";

function dummyState(): DevLoopStateEntry {
  return {
    schemaVersion: "1",
    planName: "x",
    startedAt: "2024-01-01T00:00:00.000Z",
    pid: 1,
    fingerprint: { creationTime: "x", commandLine: "y" },
    workDir: "/tmp",
    command: "node",
    args: [],
    logFile: "/tmp/x.log",
    logStartOffset: 0,
    envKind: "managed-process",
  };
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("could not pick free port"));
      }
    });
    srv.on("error", reject);
  });
}

test("port probe: ok when something is listening", async () => {
  const env = createNodeEnv();
  const srv = createServer((sock) => sock.end());
  srv.unref();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  const addr = srv.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const ctrl = new AbortController();
    const r = await portReadinessProbe.evaluate(
      { env, state: dummyState(), signal: ctrl.signal },
      { kind: "port", id: "p", host: "127.0.0.1", port, timeoutMs: 1000 },
    );
    assert.equal(r.ok, true, `expected ok, got: ${r.detail}`);
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

test("port probe: ok=false when nothing is listening", async () => {
  const env = createNodeEnv();
  const port = await pickFreePort();
  const ctrl = new AbortController();
  const r = await portReadinessProbe.evaluate(
    { env, state: dummyState(), signal: ctrl.signal },
    { kind: "port", id: "p", host: "127.0.0.1", port, timeoutMs: 500 },
  );
  assert.equal(r.ok, false);
  assert.match(r.detail, /failed|timed out/);
});

test("port probe: respects abort signal", async () => {
  const env = createNodeEnv();
  const port = await pickFreePort();
  const ctrl = new AbortController();
  ctrl.abort();
  const r = await portReadinessProbe.evaluate(
    { env, state: dummyState(), signal: ctrl.signal },
    { kind: "port", id: "p", host: "127.0.0.1", port, timeoutMs: 5000 },
  );
  assert.equal(r.ok, false);
});
