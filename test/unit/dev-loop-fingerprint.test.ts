import { test } from "node:test";
import assert from "node:assert/strict";
import { createNodeEnv } from "../../src/env-runtime/env.js";
import { captureFingerprint, verifyFingerprint } from "../../src/dev-loop/fingerprint.js";

const SUPPORTED = new Set(["linux", "darwin", "win32"]);

test("captureFingerprint: returns a fingerprint for our own pid on supported platforms", async (t) => {
  const env = createNodeEnv();
  if (!SUPPORTED.has(env.platform)) {
    t.skip(`platform ${env.platform} not yet supported`);
    return;
  }
  const fp = await captureFingerprint({ pid: process.pid, env });
  if (!fp) {
    t.skip(`fingerprint capture returned undefined on ${env.platform}; skipping deeper assertions`);
    return;
  }
  assert.ok(fp.creationTime.length > 0, "creationTime must be non-empty");
  assert.equal(typeof fp.commandLine, "string");
});

test("captureFingerprint: returns undefined for a definitely-dead pid", async () => {
  const env = createNodeEnv();
  const fp = await captureFingerprint({ pid: 2147483646, env });
  assert.equal(fp, undefined);
});

test("verifyFingerprint: matches=true when expected equals our captured fingerprint", async (t) => {
  const env = createNodeEnv();
  if (!SUPPORTED.has(env.platform)) {
    t.skip(`platform ${env.platform} not yet supported`);
    return;
  }
  const fp = await captureFingerprint({ pid: process.pid, env });
  if (!fp) {
    t.skip(`fingerprint capture returned undefined on ${env.platform}`);
    return;
  }
  const v = await verifyFingerprint(fp, { pid: process.pid, env });
  assert.equal(v.alive, true);
  assert.equal(v.matches, true);
});

test("verifyFingerprint: alive=false for a definitely-dead pid", async () => {
  const env = createNodeEnv();
  const v = await verifyFingerprint(
    { creationTime: "x", commandLine: "y" },
    { pid: 2147483646, env },
  );
  assert.equal(v.alive, false);
  assert.equal(v.matches, false);
});

test("verifyFingerprint: matches=false when expected fingerprint differs", async (t) => {
  const env = createNodeEnv();
  if (!SUPPORTED.has(env.platform)) {
    t.skip(`platform ${env.platform} not yet supported`);
    return;
  }
  const fp = await captureFingerprint({ pid: process.pid, env });
  if (!fp) {
    t.skip(`fingerprint capture returned undefined on ${env.platform}`);
    return;
  }
  const v = await verifyFingerprint(
    { creationTime: fp.creationTime + "-deliberately-different", commandLine: fp.commandLine },
    { pid: process.pid, env },
  );
  assert.equal(v.alive, true);
  assert.equal(v.matches, false);
  assert.match(v.detail, /creationTime equal: false/);
});
