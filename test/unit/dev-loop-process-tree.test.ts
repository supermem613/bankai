import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createNodeEnv } from "../../src/env-runtime/env.js";
import { isProcessAlive, terminateProcessTree } from "../../src/dev-loop/process-tree.js";

function spawnLongLivedNode(): { pid: number; child: ReturnType<typeof spawn> } {
  // A long-lived node child that sleeps 30s. detached:true gives it its own
  // process group on POSIX so terminateProcessTree's negative-pid signal
  // reaches it and any descendants. On Windows, detached just means the
  // child is decoupled from our console; taskkill /T finds the tree by pid.
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  if (typeof child.pid !== "number") {
    throw new Error("could not spawn long-lived child for test");
  }
  return { pid: child.pid, child };
}

test("isProcessAlive: returns true for our own pid", () => {
  assert.equal(isProcessAlive(process.pid), true);
});

test("isProcessAlive: returns false for a definitely-dead pid", () => {
  assert.equal(isProcessAlive(2147483646), false);
});

test("terminateProcessTree: returns killed=true immediately if pid not alive", async () => {
  const r = await terminateProcessTree({
    pid: 2147483646,
    graceMs: 100,
    env: createNodeEnv(),
  });
  assert.equal(r.killed, true);
  assert.equal(r.escalated, false);
});

test("terminateProcessTree: kills a long-lived spawned child", async () => {
  const { pid } = spawnLongLivedNode();
  // Give the child a moment to fully start.
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(isProcessAlive(pid), true);
  const result = await terminateProcessTree({
    pid,
    graceMs: 1500,
    env: createNodeEnv(),
    pollIntervalMs: 50,
  });
  assert.equal(result.killed, true, `expected killed=true, got: ${JSON.stringify(result)}`);
  // Final check: confirm the pid is gone.
  // Allow a brief window for the OS to reap.
  for (let i = 0; i < 20 && isProcessAlive(pid); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(isProcessAlive(pid), false);
});

test("terminateProcessTree: idempotent when called twice in a row", async () => {
  const { pid } = spawnLongLivedNode();
  await new Promise((r) => setTimeout(r, 100));
  const env = createNodeEnv();
  const first = await terminateProcessTree({ pid, graceMs: 1500, env, pollIntervalMs: 50 });
  assert.equal(first.killed, true);
  // Second call on the now-dead pid must succeed (killed=true) with the
  // not-alive short circuit.
  const second = await terminateProcessTree({ pid, graceMs: 100, env, pollIntervalMs: 50 });
  assert.equal(second.killed, true);
  assert.equal(second.escalated, false);
});
