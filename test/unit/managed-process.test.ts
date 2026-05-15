import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeEnv } from "../../src/env-runtime/env.js";
import {
  managedProcessPlugin,
  ManagedProcessConfigSchema,
} from "../../src/environments/managed-process.js";
import { isProcessAlive, terminateProcessTree } from "../../src/dev-loop/process-tree.js";

function makeWorkDir(): string {
  return mkdtempSync(join(tmpdir(), "bankai-mp-"));
}

test("managed-process: configSchema applies defaults", () => {
  const r = ManagedProcessConfigSchema.parse({
    command: "node",
    logFile: "x.log",
  });
  assert.deepEqual(r.args, []);
  assert.equal(r.cwd, ".");
});

test("managed-process: doctor without config returns a soft pass", async () => {
  const checks = await managedProcessPlugin.doctor(createNodeEnv());
  assert.equal(checks[0].ok, true);
  assert.match(checks[0].detail, /no config supplied/);
});

test("managed-process: doctor with config validates command + log path", async () => {
  const work = makeWorkDir();
  try {
    const checks = await managedProcessPlugin.doctor(createNodeEnv(), {
      command: "node",
      args: [],
      cwd: work,
      logFile: "logs/dev.log",
    });
    assert.ok(checks.find((c) => c.name === "command")?.ok);
    assert.ok(checks.find((c) => c.name === "logFile")?.ok);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("managed-process: setup throws (dev-loop only)", async () => {
  await assert.rejects(
    () =>
      managedProcessPlugin.setup(
        {
          env: createNodeEnv(),
          workDir: ".",
          scenarioName: "x",
          scope: { defer: () => {}, unwind: async () => {} } as never,
          signal: new AbortController().signal,
          timeoutMs: 1000,
        },
        { command: "node", args: [], cwd: ".", logFile: "x.log" },
      ),
    /dev-loop-only/,
  );
});

test("managed-process: startLongRunning spawns a real long-lived child and returns a handle", async () => {
  const work = makeWorkDir();
  const env = createNodeEnv();
  // Spawn a 30s sleep so the child outlives our quick assertions.
  const handle = await managedProcessPlugin.startLongRunning!(
    {
      env,
      workDir: work,
      planName: "test",
      signal: new AbortController().signal,
      timeoutMs: 5000,
    },
    {
      command: env.exec,
      args: ["-e", "console.log('boot ok'); setTimeout(() => {}, 30000)"],
      cwd: work,
      logFile: "logs/dev.log",
    },
  );
  try {
    assert.equal(typeof handle.pid, "number");
    assert.ok(handle.pid > 0);
    assert.equal(isProcessAlive(handle.pid), true);
    assert.equal(handle.command, env.exec);
    assert.ok(handle.logFile.endsWith("dev.log"));
    assert.equal(handle.logStartOffset, 0);
    // Wait briefly for the child to write to the log.
    for (let i = 0; i < 40; i++) {
      try {
        const contents = readFileSync(handle.logFile, "utf8");
        if (contents.includes("boot ok")) {
          break;
        }
      } catch {
        // log file may not have flushed yet
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    const final = readFileSync(handle.logFile, "utf8");
    assert.match(final, /boot ok/);
  } finally {
    await terminateProcessTree({ pid: handle.pid, graceMs: 1500, env, pollIntervalMs: 50 });
    // Allow OS reap.
    for (let i = 0; i < 20 && isProcessAlive(handle.pid); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    rmSync(work, { recursive: true, force: true });
  }
});

test("managed-process: logStartOffset captures pre-existing log size", async () => {
  const work = makeWorkDir();
  const env = createNodeEnv();
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(join(work, "logs"));
  const seedText = "stale output from a previous run\n";
  writeFileSync(join(work, "logs", "dev.log"), seedText);

  const handle = await managedProcessPlugin.startLongRunning!(
    {
      env,
      workDir: work,
      planName: "test-offset",
      signal: new AbortController().signal,
      timeoutMs: 5000,
    },
    {
      command: env.exec,
      args: ["-e", "console.log('fresh'); setTimeout(() => {}, 30000)"],
      cwd: work,
      logFile: "logs/dev.log",
    },
  );
  try {
    assert.equal(handle.logStartOffset, Buffer.byteLength(seedText));
  } finally {
    await terminateProcessTree({ pid: handle.pid, graceMs: 1500, env, pollIntervalMs: 50 });
    for (let i = 0; i < 20 && isProcessAlive(handle.pid); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    rmSync(work, { recursive: true, force: true });
  }
});

test("managed-process: startLongRunning rejects when the binary does not exist", async () => {
  const work = makeWorkDir();
  const env = createNodeEnv();
  try {
    await assert.rejects(
      () =>
        managedProcessPlugin.startLongRunning!(
          {
            env,
            workDir: work,
            planName: "test-missing",
            signal: new AbortController().signal,
            timeoutMs: 5000,
          },
          {
            command: "this-binary-does-not-exist-xyz-" + Math.random().toString(36).slice(2),
            args: [],
            cwd: work,
            logFile: "logs/dev.log",
          },
        ),
      /(ENOENT|process exited|spawn)/,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("managed-process: NEVER returns env in DevLoopHandle (state leak guard)", async () => {
  const work = makeWorkDir();
  const env = createNodeEnv();
  const handle = await managedProcessPlugin.startLongRunning!(
    {
      env,
      workDir: work,
      planName: "test-leak",
      signal: new AbortController().signal,
      timeoutMs: 5000,
    },
    {
      command: env.exec,
      args: ["-e", "setTimeout(() => {}, 30000)"],
      cwd: work,
      logFile: "logs/dev.log",
      env: { SECRET_TOKEN: "should-not-leak" },
    },
  );
  try {
    const json = JSON.stringify(handle);
    assert.equal(json.includes("SECRET_TOKEN"), false);
    assert.equal(json.includes("should-not-leak"), false);
  } finally {
    await terminateProcessTree({ pid: handle.pid, graceMs: 1500, env, pollIntervalMs: 50 });
    for (let i = 0; i < 20 && isProcessAlive(handle.pid); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    rmSync(work, { recursive: true, force: true });
  }
});
