import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRunCommand } from "../../src/commands/run.js";
import { runStopCommand } from "../../src/commands/stop.js";
import { createNodeEnv } from "../../src/env-runtime/env.js";
import { createRegistryStore } from "../../src/registry/store.js";

import "../../src/steps/index.js";
import "../../src/assertions/index.js";
import "../../src/environments/index.js";
import "../../src/tools/index.js";
import "../../src/readiness/index.js";

// Integration tests for managed-process stdin stop strategy.
// A child process is started that listens on stdin for "q\n" and exits
// gracefully only when it receives that input. We verify that bankai
// stop delivers the input and the process exits without escalation.

describe("managed-process: stdin stop strategy", () => {
  let tmp: string;
  let env: ReturnType<typeof createNodeEnv>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "bankai-stdin-stop-"));
    const baseEnv = createNodeEnv();
    env = { ...baseEnv, home: tmp };
  });

  afterEach(async () => {
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

  it("delivers stdin input and process exits gracefully without escalation", async () => {
    // Child script: waits for "q\n" on stdin, writes confirmation to a
    // file, then exits 0. Stays alive indefinitely otherwise.
    const confirmFile = join(tmp, "received.txt");
    const childJs = join(tmp, "stdin-child.cjs");
    writeFileSync(
      childJs,
      `'use strict';
const fs = require('fs');
const confirmFile = ${JSON.stringify(confirmFile)};
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  if (buf.includes('q\\n') || buf.includes('q')) {
    fs.writeFileSync(confirmFile, buf, 'utf8');
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  fs.writeFileSync(confirmFile, 'stdin-ended:' + buf, 'utf8');
  process.exit(0);
});
// Keep alive
setInterval(() => {}, 60000);
`,
    );

    const planPath = join(tmp, "stdin-stop.plan.json");
    writeFileSync(
      planPath,
      JSON.stringify({
        schemaVersion: "1",
        name: "stdin-stop-test",
        steps: [
          {
            id: "boot",
            kind: "setup",
            env: "managed-process",
            registerAs: "bankai-test-stdin",
            config: {
              command: process.execPath,
              args: [childJs],
              cwd: ".",
              logFile: "logs/stdin-child.log",
              stop: {
                kind: "stdin",
                input: "q\n",
                graceMs: 5000,
              },
            },
            setupTimeoutMs: 10000,
          },
        ],
      }),
    );

    // Start the process
    const startResult = await runRunCommand({ planPath, env, logDir: join(tmp, "logs"), repoRoot: tmp });
    assert.equal(startResult.ok, true, JSON.stringify(startResult.failure ?? startResult.steps));

    // Verify it is registered
    const store = createRegistryStore({ env });
    const entry = await store.getEntry("bankai-test-stdin");
    assert.ok(entry, "entry must be registered");
    assert.ok(entry.stop, "stop strategy must be persisted in registry");
    assert.equal(entry.stop.kind, "stdin");
    assert.equal(entry.stop.input, "q\n");

    // Give the relay+child a moment to start
    await new Promise((r) => setTimeout(r, 500));

    // Stop via bankai stop command
    const stopped = await runStopCommand({
      name: "bankai-test-stdin",
      env,
      logDir: join(tmp, "logs"),
      repoRoot: tmp,
    });
    assert.equal(stopped.ok, true, JSON.stringify(stopped.failure));

    // Verify: no escalation
    const reg = stopped.registry as Array<{ escalated?: boolean; detail?: string }>;
    assert.equal(reg[0]?.escalated, false, `should not escalate; detail: ${reg[0]?.detail}`);

    // Verify: child received the input
    assert.ok(existsSync(confirmFile), "child must have written confirmation file");
    const received = readFileSync(confirmFile, "utf8");
    assert.ok(received.includes("q"), `child received: ${received}`);

    // Verify: registry entry removed
    const afterEntry = await store.getEntry("bankai-test-stdin");
    assert.equal(afterEntry, undefined, "registry entry must be removed after stop");
  });

  it("escalates to process-tree termination when child ignores stdin input", async () => {
    // Child script that ignores stdin entirely
    const childJs = join(tmp, "ignores-stdin.cjs");
    writeFileSync(
      childJs,
      `'use strict';
// Deliberately ignores stdin
setInterval(() => {}, 60000);
`,
    );

    const planPath = join(tmp, "stdin-ignore.plan.json");
    writeFileSync(
      planPath,
      JSON.stringify({
        schemaVersion: "1",
        name: "stdin-ignore-test",
        steps: [
          {
            id: "boot",
            kind: "setup",
            env: "managed-process",
            registerAs: "bankai-test-stdin-ignore",
            config: {
              command: process.execPath,
              args: [childJs],
              cwd: ".",
              logFile: "logs/ignore-child.log",
              stop: {
                kind: "stdin",
                input: "q\n",
                graceMs: 1000,
              },
            },
            setupTimeoutMs: 10000,
          },
        ],
      }),
    );

    const startResult = await runRunCommand({ planPath, env, logDir: join(tmp, "logs"), repoRoot: tmp });
    assert.equal(startResult.ok, true, JSON.stringify(startResult.failure ?? startResult.steps));

    await new Promise((r) => setTimeout(r, 500));

    const stopped = await runStopCommand({
      name: "bankai-test-stdin-ignore",
      env,
      logDir: join(tmp, "logs"),
      repoRoot: tmp,
    });
    assert.equal(stopped.ok, true, JSON.stringify(stopped.failure));

    // Should have escalated since child ignored stdin
    const reg = stopped.registry as Array<{ escalated?: boolean; detail?: string }>;
    assert.equal(reg[0]?.escalated, true, "must escalate when child ignores stdin");

    // Registry entry still removed
    const store = createRegistryStore({ env });
    const afterEntry = await store.getEntry("bankai-test-stdin-ignore");
    assert.equal(afterEntry, undefined);
  });

  it("managed process without stop config still uses existing termination", async () => {
    // Regression: a plain managed process (no stop config) must still
    // be terminated via SIGTERM/process-tree as before.
    const childJs = join(tmp, "plain-child.cjs");
    writeFileSync(
      childJs,
      `'use strict';\nsetInterval(() => {}, 60000);\n`,
    );

    const planPath = join(tmp, "plain.plan.json");
    writeFileSync(
      planPath,
      JSON.stringify({
        schemaVersion: "1",
        name: "plain-test",
        steps: [
          {
            id: "boot",
            kind: "setup",
            env: "managed-process",
            registerAs: "bankai-test-plain",
            config: {
              command: process.execPath,
              args: [childJs],
              cwd: ".",
              logFile: "logs/plain.log",
            },
            setupTimeoutMs: 10000,
          },
        ],
      }),
    );

    const startResult = await runRunCommand({ planPath, env, logDir: join(tmp, "logs"), repoRoot: tmp });
    assert.equal(startResult.ok, true, JSON.stringify(startResult.failure ?? startResult.steps));

    await new Promise((r) => setTimeout(r, 300));

    const stopped = await runStopCommand({
      name: "bankai-test-plain",
      env,
      logDir: join(tmp, "logs"),
      repoRoot: tmp,
    });
    assert.equal(stopped.ok, true, JSON.stringify(stopped.failure));

    const store = createRegistryStore({ env });
    const afterEntry = await store.getEntry("bankai-test-plain");
    assert.equal(afterEntry, undefined);
  });

  it("stop step also honors stdin strategy", async () => {
    const confirmFile = join(tmp, "step-received.txt");
    const childJs = join(tmp, "step-stdin-child.cjs");
    writeFileSync(
      childJs,
      `'use strict';
const fs = require('fs');
const confirmFile = ${JSON.stringify(confirmFile)};
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  if (buf.includes('q')) {
    fs.writeFileSync(confirmFile, buf, 'utf8');
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  fs.writeFileSync(confirmFile, 'stdin-ended:' + buf, 'utf8');
  process.exit(0);
});
setInterval(() => {}, 60000);
`,
    );

    // Plan that starts AND stops in the same run via a stop step
    const planPath = join(tmp, "step-stop.plan.json");
    writeFileSync(
      planPath,
      JSON.stringify({
        schemaVersion: "1",
        name: "step-stop-test",
        steps: [
          {
            id: "boot",
            kind: "setup",
            env: "managed-process",
            registerAs: "bankai-test-step-stdin",
            config: {
              command: process.execPath,
              args: [childJs],
              cwd: ".",
              logFile: "logs/step-stdin.log",
              stop: {
                kind: "stdin",
                input: "q\n",
                graceMs: 5000,
              },
            },
            setupTimeoutMs: 10000,
          },
          {
            id: "pause",
            kind: "shell",
            command: process.execPath,
            args: ["-e", "setTimeout(()=>{},1000)"],
          },
          {
            id: "teardown",
            kind: "stop",
            name: "bankai-test-step-stdin",
            graceMs: 5000,
          },
        ],
      }),
    );

    const result = await runRunCommand({ planPath, env, logDir: join(tmp, "logs"), repoRoot: tmp });
    assert.equal(result.ok, true, JSON.stringify(result.failure ?? result.steps));

    // Verify the child received input
    assert.ok(existsSync(confirmFile), "child must have written confirmation via stop step");
    const received = readFileSync(confirmFile, "utf8");
    assert.ok(received.includes("q"), `child received: ${received}`);

    // Registry should be empty
    const store = createRegistryStore({ env });
    const afterEntry = await store.getEntry("bankai-test-step-stdin");
    assert.equal(afterEntry, undefined);
  });

  it("rejects empty stdin input in schema validation", async () => {
    const planPath = join(tmp, "bad-schema.plan.json");
    writeFileSync(
      planPath,
      JSON.stringify({
        schemaVersion: "1",
        name: "bad-schema-test",
        steps: [
          {
            id: "boot",
            kind: "setup",
            env: "managed-process",
            registerAs: "bankai-test-bad",
            config: {
              command: process.execPath,
              args: ["-e", "1"],
              cwd: ".",
              logFile: "logs/bad.log",
              stop: {
                kind: "stdin",
                input: "",
              },
            },
            setupTimeoutMs: 10000,
          },
        ],
      }),
    );

    const result = await runRunCommand({ planPath, env, logDir: join(tmp, "logs"), repoRoot: tmp });
    assert.equal(result.ok, false, "empty input must fail validation");
  });
});
