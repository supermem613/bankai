import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runRunCommand } from "../../src/commands/run.js";
import { runStatusCommand } from "../../src/commands/status.js";
import { runLogsCommand } from "../../src/commands/logs.js";
import { runStopCommand } from "../../src/commands/stop.js";
import { createNodeEnv } from "../../src/env-runtime/env.js";
import { createRegistryStore } from "../../src/registry/store.js";

import "../../src/steps/index.js";
import "../../src/assertions/index.js";
import "../../src/environments/index.js";
import "../../src/tools/index.js";
import "../../src/readiness/index.js";

describe("orchestrator: attached-process plans", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "bankai-run-attached-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  async function getFreePort(): Promise<number> {
    return await new Promise((resolve, reject) => {
      const server = createServer();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("expected TCP address"));
          return;
        }
        server.close(() => resolve(address.port));
      });
    });
  }

  async function waitForFile(path: string, timeoutMs = 5000): Promise<void> {
    if (existsSync(path)) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        watcher.close();
        reject(new Error(`timed out waiting for ${path}`));
      }, timeoutMs);
      const watcher = watch(dirname(path), () => {
        if (existsSync(path)) {
          clearTimeout(timer);
          watcher.close();
          resolve();
        }
      });
    });
  }

  function isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  function killPidIfAlive(pid: number): void {
    if (!isPidAlive(pid)) {
      return;
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
        throw err;
      }
    }
  }

  it("treats Ctrl+C style exit codes as a successful attached dev-loop stop", async () => {
    const planPath = join(tmp, "attached.plan.json");
    writeFileSync(
      planPath,
      JSON.stringify({
        schemaVersion: "1",
        name: "attached-ok",
        steps: [
          {
            id: "dev",
            kind: "attached-process",
            command: process.execPath,
            args: ["-e", "process.exit(130)"],
            stdio: "pipe",
          },
        ],
      }),
    );

    const env = { ...createNodeEnv(), home: tmp };
    const envelope = await runRunCommand({ planPath, env, logDir: join(tmp, "logs"), repoRoot: tmp, visibleAttachedTerminal: true });
    assert.equal(envelope.ok, true, JSON.stringify(envelope.failure));
    assert.equal(envelope.steps[0].attachedProcess?.exitCode, 130);
    assert.equal(envelope.steps[0].attachedProcess?.escalated, false);

    const status = await runStatusCommand({ env, logDir: join(tmp, "logs"), repoRoot: tmp });
    assert.equal(status.registry?.length, 0);
  });

  it("blocks attached processes by default before spawning unless caller confirms visibility", async () => {
    const marker = join(tmp, "spawned.txt");
    const planPath = join(tmp, "attached-visible-required.plan.json");
    writeFileSync(
      planPath,
      JSON.stringify({
        schemaVersion: "1",
        name: "attached-visible-required",
        steps: [
          {
            id: "dev",
            kind: "attached-process",
            command: process.execPath,
            args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned'); process.exit(0);`],
          },
        ],
      }),
    );

    const envelope = await runRunCommand({ planPath, env: createNodeEnv(), logDir: join(tmp, "logs"), repoRoot: tmp });
    assert.equal(envelope.ok, false);
    assert.match(envelope.failure?.reason ?? "", /visible terminal/);
    assert.equal(existsSync(marker), false, "guard must fail before spawning the attached process");
  });

  it("allows attached processes when caller confirms visibility", async () => {
    const planPath = join(tmp, "attached-visible-confirmed.plan.json");
    writeFileSync(
      planPath,
      JSON.stringify({
        schemaVersion: "1",
        name: "attached-visible-confirmed",
        steps: [
          {
            id: "dev",
            kind: "attached-process",
            command: process.execPath,
            args: ["-e", "process.exit(0)"],
          },
        ],
      }),
    );

    const envelope = await runRunCommand({
      planPath,
      env: createNodeEnv(),
      logDir: join(tmp, "logs"),
      repoRoot: tmp,
      visibleAttachedTerminal: true,
    });
    assert.equal(envelope.ok, true, JSON.stringify(envelope.failure));
  });

  it("registers attached runs for status and stops them through the control channel", async () => {
    const readyFile = join(tmp, "ready.json");
    const planPath = join(tmp, "attached-control.plan.json");
    writeFileSync(
      planPath,
      JSON.stringify({
        schemaVersion: "1",
        name: "attached-control",
        steps: [
          {
            id: "dev",
            kind: "attached-process",
            command: process.execPath,
            args: ["-e", `
              const fs = require('node:fs');
              fs.writeFileSync(${JSON.stringify(readyFile)}, '{}');
              setInterval(() => {}, 1000);
            `],
            timeoutMs: 5000,
          },
        ],
      }),
    );
    const baseEnv = createNodeEnv();
    const env = { ...baseEnv, home: tmp };
    const runPromise = runRunCommand({
      planPath,
      env,
      logDir: join(tmp, "logs"),
      repoRoot: tmp,
      visibleAttachedTerminal: true,
    });

    await waitForFile(readyFile);
    const status = await runStatusCommand({ env, logDir: join(tmp, "logs"), repoRoot: tmp });
    const entry = status.registry?.find((item) => (item as { name?: string }).name === "attached-control") as { alive?: boolean } | undefined;
    assert.equal(entry?.alive, true);

    const stop = await runStopCommand({ name: "attached-control", env, logDir: join(tmp, "logs"), repoRoot: tmp, graceMs: 5000 });
    assert.equal(stop.ok, true, JSON.stringify(stop.failure));
    assert.equal(stop.registry?.[0] && (stop.registry[0] as { escalated?: boolean }).escalated, false);

    const runEnvelope = await runPromise;
    assert.equal(runEnvelope.ok, true, JSON.stringify(runEnvelope.failure));
    const after = await runStatusCommand({ env, logDir: join(tmp, "logs"), repoRoot: tmp });
    assert.equal(after.registry?.some((item) => (item as { name?: string }).name === "attached-control"), false);
  });

  it("does not report attached stop success until the tracked child tree is gone", async () => {
    const readyFile = join(tmp, "tree-ready.json");
    const childPidFile = join(tmp, "child-pid.txt");
    const planPath = join(tmp, "attached-control-tree.plan.json");
    writeFileSync(
      planPath,
      JSON.stringify({
        schemaVersion: "1",
        name: "attached-control-tree",
        steps: [
          {
            id: "dev",
            kind: "attached-process",
            command: process.execPath,
            args: ["-e", `
              const { spawn } = require('node:child_process');
              const fs = require('node:fs');
              const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
              child.unref();
              fs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));
              fs.writeFileSync(${JSON.stringify(readyFile)}, '{}');
              process.on('SIGINT', () => process.exit(0));
              setInterval(() => {}, 1000);
            `],
            timeoutMs: 5000,
          },
        ],
      }),
    );
    const baseEnv = createNodeEnv();
    const env = { ...baseEnv, home: tmp };
    let childPid = 0;
    const runPromise = runRunCommand({
      planPath,
      env,
      logDir: join(tmp, "logs"),
      repoRoot: tmp,
      visibleAttachedTerminal: true,
    });

    try {
      await waitForFile(readyFile);
      childPid = Number(readFileSync(childPidFile, "utf8"));
      assert.equal(Number.isInteger(childPid), true);
      assert.equal(isPidAlive(childPid), true);

      const stop = await runStopCommand({ name: "attached-control-tree", env, logDir: join(tmp, "logs"), repoRoot: tmp, graceMs: 5000 });
      assert.equal(stop.ok, true, JSON.stringify(stop.failure));
      assert.equal(isPidAlive(childPid), false, `child pid ${childPid} should not survive a successful stop`);
      assert.match((stop.registry?.[0] as { detail?: string } | undefined)?.detail ?? "", /tracked/);

      const runEnvelope = await runPromise;
      assert.equal(runEnvelope.ok, true, JSON.stringify(runEnvelope.failure));
    } finally {
      if (childPid > 0) {
        killPidIfAlive(childPid);
      }
    }
  });

  it("writes a parent ready event when an attached process becomes ready", async () => {
    const readyEventFile = join(tmp, "parent-ready.json");
    const planPath = join(tmp, "attached-ready-event.plan.json");
    const stdoutWrites: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
      stdoutWrites.push(String(chunk));
      return originalWrite.apply(process.stdout, [chunk, ...args] as Parameters<typeof process.stdout.write>);
    }) as typeof process.stdout.write;
    writeFileSync(
      planPath,
      JSON.stringify({
        schemaVersion: "1",
        name: "attached-ready-event",
        steps: [
          {
            id: "dev",
            kind: "attached-process",
            command: process.execPath,
            args: ["-e", "console.log('READY'); setTimeout(() => process.exit(0), 250);"],
            timeoutMs: 5000,
            readyWhen: [{ id: "ready-line", stream: "stdout", contains: "READY" }],
            announceReady: true,
          },
        ],
      }),
    );
    const env = { ...createNodeEnv(), home: tmp };
    try {
      const runPromise = runRunCommand({
        planPath,
        env,
        logDir: join(tmp, "logs"),
        repoRoot: tmp,
        visibleAttachedTerminal: true,
        visibleReadyEventFile: readyEventFile,
      });

      await waitForFile(readyEventFile);
      const ready = JSON.parse(readFileSync(readyEventFile, "utf8")) as { ok?: boolean; event?: string; stepId?: string };
      assert.equal(ready.ok, true);
      assert.equal(ready.event, "bankai.ready");
      assert.equal(ready.stepId, "dev");

      const envelope = await runPromise;
      assert.equal(envelope.ok, true, JSON.stringify(envelope.failure));
      assert.doesNotMatch(stdoutWrites.join(""), /BANKAI_READY/);
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  it("keeps status concise and exposes detailed log tails through logs", async () => {
    const logFile = join(tmp, "logs", "child.jsonl");
    const transcriptFile = `${logFile}.terminal.txt`;
    mkdirSync(dirname(logFile), { recursive: true });
    writeFileSync(logFile, '{"event":"launch.failed","reason":"attached not found"}\n');
    writeFileSync(transcriptFile, "attached not found\nPress Enter to close\n");

    const baseEnv = createNodeEnv();
    const env = { ...baseEnv, home: tmp };
    await createRegistryStore({ env }).putEntry({
      pid: process.pid,
      command: process.execPath,
      args: ["dist\\cli.js", "run", "plan.json"],
      workDir: tmp,
      envKind: "visible-terminal-launch",
      logFile,
      logStartOffset: 0,
      name: "attached-control",
      planName: "attached-control",
      planPath: join(tmp, "plan.json"),
      cwd: tmp,
      registeredAt: baseEnv.clock.isoNow(),
      evidence: {
        transcriptFile,
        detail: "visible terminal launch record",
      },
    });

    const status = await runStatusCommand({ name: "attached-control", env, logDir: join(tmp, "logs"), repoRoot: tmp });
    assert.equal(status.ok, true);
    const entry = status.registry?.[0] as {
      statusEvidence?: unknown;
      logs?: {
        run?: { path?: string; exists?: boolean };
        transcript?: { path?: string; exists?: boolean };
      };
    };
    assert.equal(entry.statusEvidence, undefined);
    assert.equal(entry.logs?.run?.path, logFile);
    assert.equal(entry.logs?.run?.exists, true);
    assert.equal(entry.logs?.transcript?.path, transcriptFile);
    assert.equal(entry.logs?.transcript?.exists, true);

    const logs = await runLogsCommand({ name: "attached-control", env, logDir: join(tmp, "logs"), repoRoot: tmp });
    assert.equal(logs.ok, true);
    const logEntry = logs.registry?.[0] as {
      logs?: {
        run?: { tail?: string };
        transcript?: { tail?: string };
      };
    };
    assert.match(logEntry.logs?.run?.tail ?? "", /launch\.failed/);
    assert.match(logEntry.logs?.transcript?.tail ?? "", /attached not found/);
  });

  it("resolves Windows command shims without hardcoded node_modules paths in plans", async () => {
    const shimDir = join(tmp, "shim");
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(
      join(shimDir, "agent.cmd"),
      `@echo off\r\n"%BANKAI_TEST_NODE%" -e "process.exit(process.argv.includes('sentinel') ? 0 : 9)" %*\r\n`,
    );

    const planPath = join(tmp, "attached-shim.plan.json");
    writeFileSync(
      planPath,
      JSON.stringify({
        schemaVersion: "1",
        name: "attached-shim",
        steps: [
          {
            id: "dev",
            kind: "attached-process",
            command: "agent",
            args: ["sentinel"],
            stdio: "pipe",
          },
        ],
      }),
    );

    const baseEnv = createNodeEnv();
    const env = {
      ...baseEnv,
      platform: "win32" as const,
      exec: process.execPath,
      env: { ...baseEnv.env, PATH: shimDir, PATHEXT: ".CMD", BANKAI_TEST_NODE: process.execPath, ComSpec: baseEnv.env.ComSpec ?? baseEnv.env.COMSPEC },
    };
    const envelope = await runRunCommand({ planPath, env, logDir: join(tmp, "logs"), repoRoot: tmp, visibleAttachedTerminal: true });
    assert.equal(envelope.ok, true, JSON.stringify(envelope.failure));
    assert.equal(envelope.steps[0].attachedProcess?.exitCode, 0);
  });

  it("publishes readiness after output match and then verifies configured probes once", async () => {
    const port = await getFreePort();
    const readyFile = join(tmp, "events", "ready.json");
    const planPath = join(tmp, "attached-ready.plan.json");
    writeFileSync(
      planPath,
      JSON.stringify({
        schemaVersion: "1",
        name: "attached-ready",
        steps: [
          {
            id: "dev",
            kind: "attached-process",
            command: process.execPath,
            args: ["-e", `
              const net = require('node:net');
              const server = net.createServer();
              server.listen(${port}, '127.0.0.1', () => console.log('Press CTRL-C to stop'));
              setTimeout(() => server.close(() => process.exit(0)), 250);
            `],
            readyWhen: [{ id: "ready-line", contains: "Press CTRL-C to stop" }],
            verifyReady: [{ kind: "port", id: "server", host: "127.0.0.1", port, timeoutMs: 1000 }],
            readyEventFile: readyFile,
            announceReady: false,
            timeoutMs: 5000,
          },
        ],
      }),
    );

    const envelope = await runRunCommand({ planPath, env: createNodeEnv(), logDir: join(tmp, "logs"), repoRoot: tmp, visibleAttachedTerminal: true });
    assert.equal(envelope.ok, true, JSON.stringify(envelope.failure));
    assert.ok(existsSync(readyFile), "ready event file should be written after output readiness and port verification");
    const ready = JSON.parse(readFileSync(readyFile, "utf8"));
    assert.equal(ready.match.id, "ready-line");
    assert.equal(ready.observations[0].ok, true);
  });

  it("fails proactively when attached output matches a configured failure pattern", async () => {
    const planPath = join(tmp, "attached-output-fail.plan.json");
    writeFileSync(
      planPath,
      JSON.stringify({
        schemaVersion: "1",
        name: "attached-output-fail",
        steps: [
          {
            id: "dev",
            kind: "attached-process",
            command: process.execPath,
            args: ["-e", "console.error('Compilation failed with error: nope'); setInterval(() => {}, 1000);"],
            failWhen: [{ id: "compile-failed", stream: "stderr", contains: "Compilation failed with error:" }],
            timeoutMs: 5000,
          },
        ],
      }),
    );

    const envelope = await runRunCommand({ planPath, env: createNodeEnv(), logDir: join(tmp, "logs"), repoRoot: tmp, visibleAttachedTerminal: true });
    assert.equal(envelope.ok, false);
    assert.match(envelope.failure?.reason ?? "", /compile-failed/);
  });

  it("fails when the attached process exits with an unexpected code", async () => {
    const planPath = join(tmp, "attached-fail.plan.json");
    writeFileSync(
      planPath,
      JSON.stringify({
        schemaVersion: "1",
        name: "attached-fail",
        steps: [
          {
            id: "dev",
            kind: "attached-process",
            command: process.execPath,
            args: ["-e", "process.exit(7)"],
            stdio: "pipe",
          },
        ],
      }),
    );

    const baseEnv = createNodeEnv();
    const env = { ...baseEnv, home: tmp };
    const envelope = await runRunCommand({ planPath, env, logDir: join(tmp, "logs"), repoRoot: tmp, visibleAttachedTerminal: true });
    assert.equal(envelope.ok, false);
    assert.equal(envelope.steps[0].attachedProcess?.exitCode, 7);
    assert.match(envelope.failure?.reason ?? "", /attached-process/);
    const status = await runStatusCommand({ name: "attached-fail", env, logDir: join(tmp, "logs"), repoRoot: tmp });
    assert.equal(status.registry?.length, 1);
    const entry = status.registry?.[0] as { alive?: boolean; status?: { phase?: string; done?: boolean; ready?: boolean; detail?: string } };
    assert.equal(entry.alive, false);
    assert.equal(entry.status?.phase, "failed");
    assert.equal(entry.status?.done, true);
    assert.equal(entry.status?.ready, false);
    assert.match(entry.status?.detail ?? "", /code 7/);
  });
});
