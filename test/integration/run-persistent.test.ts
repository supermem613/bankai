import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join } from "node:path";
import { runRunCommand } from "../../src/commands/run.js";
import { runStopCommand } from "../../src/commands/stop.js";
import { runStatusCommand } from "../../src/commands/status.js";
import { createNodeEnv } from "../../src/env-runtime/env.js";
import { createRegistryStore } from "../../src/registry/store.js";

import "../../src/steps/index.js";
import "../../src/assertions/index.js";
import "../../src/environments/index.js";
import "../../src/tools/index.js";
import "../../src/readiness/index.js";

// Self-hosted persistent plan: spawn a long-lived node http server via
// managed-process, wait for its port to come up, then verify status
// shows it, then stop it via the stop command. The whole cycle runs
// against a sandboxed home so the per-user registry stays isolated.
//
// We use port 0 trick by writing a small server JS that picks a port
// and writes it to a file before listening. The wait step polls a port
// readiness probe targeting that port. To avoid the file-bridge
// complication we instead pre-pick a free ephemeral port outside the
// plan and pass it via env to the server child.

async function pickFreePort(): Promise<number> {
  const srv = createServer();
  return new Promise<number>((resolve, reject) => {
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object" && "port" in addr) {
        const p = (addr as { port: number }).port;
        srv.close(() => resolve(p));
      } else {
        reject(new Error("no port"));
      }
    });
  });
}

describe("orchestrator: persistent plans", () => {
  let tmp: string;
  let env: ReturnType<typeof createNodeEnv>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "bankai-run-persist-"));
    const baseEnv = createNodeEnv();
    env = { ...baseEnv, home: tmp };
  });

  afterEach(async () => {
    // Best-effort: force-stop anything we registered so we never leak
    // a server past the test.
    try {
      const store = createRegistryStore({ env });
      const file = await store.read();
      for (const entry of Object.values(file.entries)) {
        await runStopCommand({ name: entry.name, force: true, env, logDir: join(tmp, "logs"), repoRoot: tmp });
      }
    } catch {
      // ignore
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("setup (registerAs) + wait (port) + stop persists and tears down cleanly", async () => {
    const port = await pickFreePort();
    const serverJs = join(tmp, "server.cjs");
    writeFileSync(
      serverJs,
      `const http = require('http');\nconst p = parseInt(process.env.PORT, 10);\nconst s = http.createServer((req, res) => { res.end('hi'); });\ns.listen(p, '127.0.0.1');\nsetInterval(() => {}, 60_000);\n`,
    );

    const planPath = join(tmp, "node-server.plan.json");
    writeFileSync(
      planPath,
      JSON.stringify({
        schemaVersion: "1",
        name: "node-server-self",
        steps: [
          {
            id: "boot",
            kind: "setup",
            env: "managed-process",
            registerAs: "bankai-test-node-server",
            config: {
              command: process.execPath,
              args: [serverJs],
              cwd: ".",
              logFile: "logs/server.log",
              env: { PORT: String(port) },
            },
            setupTimeoutMs: 10000,
          },
          {
            id: "ready",
            kind: "wait",
            fromStepId: "boot",
            for: [{ kind: "port", id: "p1", host: "127.0.0.1", port }],
            timeoutMs: 10000,
            pollIntervalMs: 200,
          },
        ],
      }),
    );

    const startEnv = await runRunCommand({ planPath, env, logDir: join(tmp, "logs"), repoRoot: tmp });
    assert.equal(startEnv.ok, true, JSON.stringify(startEnv.failure ?? startEnv.steps));
    assert.equal(startEnv.registry?.length, 1);
    const runEntry = (startEnv.registry as Array<{
      name: string;
      alive: boolean;
      status?: { phase?: string; ready?: boolean; done?: boolean };
      logs?: { run?: { path?: string; exists?: boolean } };
    }>)[0];
    assert.equal(runEntry.name, "bankai-test-node-server");
    assert.equal(runEntry.alive, true);
    assert.equal(runEntry.status?.phase, "running");
    assert.equal(runEntry.status?.ready, false);
    assert.equal(runEntry.status?.done, false);
    assert.equal(runEntry.logs?.run?.exists, true);

    const status = await runStatusCommand({ name: "bankai-test-node-server", env, logDir: join(tmp, "logs"), repoRoot: tmp });
    assert.equal(status.ok, true);
    assert.equal(status.registry?.length, 1);
    const entry = (status.registry as { name: string; alive: boolean }[])[0];
    assert.equal(entry.name, "bankai-test-node-server");
    assert.equal(entry.alive, true);

    const stopped = await runStopCommand({ name: "bankai-test-node-server", env, logDir: join(tmp, "logs"), repoRoot: tmp });
    assert.equal(stopped.ok, true, JSON.stringify(stopped.failure));

    const after = await runStatusCommand({ env, logDir: join(tmp, "logs"), repoRoot: tmp });
    assert.equal(after.registry?.length, 0);
  });

  it("rejects a second registerAs while the first is alive", async () => {
    const port = await pickFreePort();
    const serverJs = join(tmp, "server.cjs");
    writeFileSync(
      serverJs,
      `const http = require('http');\nconst p = parseInt(process.env.PORT, 10);\nhttp.createServer((req, res) => res.end('x')).listen(p, '127.0.0.1');\nsetInterval(()=>{}, 60_000);\n`,
    );
    const planPath = join(tmp, "p.plan.json");
    writeFileSync(
      planPath,
      JSON.stringify({
        schemaVersion: "1",
        name: "double-register",
        steps: [
          {
            id: "boot",
            kind: "setup",
            env: "managed-process",
            registerAs: "bankai-test-double",
            config: {
              command: process.execPath,
              args: [serverJs],
              cwd: ".",
              logFile: "logs/server.log",
              env: { PORT: String(port) },
            },
            setupTimeoutMs: 10000,
          },
        ],
      }),
    );
    const first = await runRunCommand({ planPath, env, logDir: join(tmp, "logs"), repoRoot: tmp });
    assert.equal(first.ok, true);
    try {
      const second = await runRunCommand({ planPath, env, logDir: join(tmp, "logs"), repoRoot: tmp });
      assert.equal(second.ok, false, "second register must fail while first is alive");
      assert.match(second.failure?.reason ?? "", /already running|in_progress|already/i);
    } finally {
      await runStopCommand({ name: "bankai-test-double", force: true, env, logDir: join(tmp, "logs"), repoRoot: tmp });
    }
  });

  it("refuses to stop a live PID when the fingerprint does not match", async () => {
    const store = createRegistryStore({ env });
    await store.putEntry({
      name: "bankai-test-fingerprint-mismatch",
      planName: "fingerprint-mismatch",
      planPath: join(tmp, "fingerprint.plan.json"),
      cwd: tmp,
      registeredAt: env.clock.isoNow(),
      pid: process.pid,
      command: "wrong-command",
      args: [],
      workDir: tmp,
      envKind: "managed-process",
      logFile: join(tmp, "fingerprint.log"),
      logStartOffset: 0,
      fingerprint: {
        creationTime: "not-the-current-process",
        commandLine: "not-the-current-process",
      },
    });
    try {
      const stopped = await runStopCommand({
        name: "bankai-test-fingerprint-mismatch",
        env,
        logDir: join(tmp, "logs"),
        repoRoot: tmp,
      });
      assert.equal(stopped.ok, false);
      assert.equal(stopped.failure?.stage, "fingerprint");
      const entry = await store.getEntry("bankai-test-fingerprint-mismatch");
      assert.ok(entry);
    } finally {
      await store.removeEntry("bankai-test-fingerprint-mismatch");
    }
  });
});
