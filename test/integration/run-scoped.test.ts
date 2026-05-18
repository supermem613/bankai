import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRunCommand } from "../../src/commands/run.js";
import { createNodeEnv } from "../../src/env-runtime/env.js";

// Side-effect imports register the built-in step kinds, env plugins,
// tool plugins, assertions, and readiness probes for tests that exercise
// the orchestrator end-to-end.
import "../../src/steps/index.js";
import "../../src/assertions/index.js";
import "../../src/environments/index.js";
import "../../src/tools/index.js";
import "../../src/readiness/index.js";

describe("orchestrator: scoped plans", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "bankai-run-scoped-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("runs a shell + assert plan and reports ok", async () => {
    const planPath = join(tmp, "p.plan.json");
    writeFileSync(
      planPath,
      JSON.stringify({
        schemaVersion: "1",
        name: "shell-and-assert",
        steps: [
          {
            id: "v",
            kind: "shell",
            command: process.execPath,
            args: ["-e", "process.stdout.write('READY: 42')"],
          },
          {
            id: "a",
            kind: "assert",
            assertion: "step-output-contains",
            config: { stepId: "v", text: "READY: 42" },
          },
        ],
      }),
    );
    const env = createNodeEnv();
    const envelope = await runRunCommand({
      planPath,
      env,
      logDir: join(tmp, "logs"),
      repoRoot: tmp,
    });
    assert.equal(envelope.ok, true, JSON.stringify(envelope.failure));
    assert.equal(envelope.steps.length, 2);
    assert.equal(envelope.steps[0].ok, true);
    assert.equal(envelope.steps[1].ok, true);
  });

  it("stops the plan on a failed step unless continueOnFail is set", async () => {
    const planPath = join(tmp, "p.plan.json");
    writeFileSync(
      planPath,
      JSON.stringify({
        schemaVersion: "1",
        name: "stop-on-fail",
        steps: [
          { id: "v", kind: "shell", command: process.execPath, args: ["-e", "process.exit(7)"] },
          { id: "after", kind: "shell", command: process.execPath, args: ["-e", "console.log('skipped')"] },
        ],
      }),
    );
    const envelope = await runRunCommand({ planPath, env: createNodeEnv(), logDir: join(tmp, "logs"), repoRoot: tmp });
    assert.equal(envelope.ok, false);
    assert.equal(envelope.steps.length, 1);
    assert.equal(envelope.steps[0].ok, false);
  });

  it("continueOnFail allows later steps to run after a failure", async () => {
    const planPath = join(tmp, "p.plan.json");
    writeFileSync(
      planPath,
      JSON.stringify({
        schemaVersion: "1",
        name: "continue-on-fail",
        steps: [
          {
            id: "fail",
            kind: "shell",
            command: process.execPath,
            args: ["-e", "process.exit(3)"],
            continueOnFail: true,
          },
          { id: "ok", kind: "shell", command: process.execPath, args: ["-e", "process.exit(0)"] },
        ],
      }),
    );
    const envelope = await runRunCommand({ planPath, env: createNodeEnv(), logDir: join(tmp, "logs"), repoRoot: tmp });
    assert.equal(envelope.ok, false);
    assert.equal(envelope.steps.length, 2);
    assert.equal(envelope.steps[0].ok, false);
    assert.equal(envelope.steps[1].ok, true);
  });

  it("retries shell steps with bounded attempts", async () => {
    const planPath = join(tmp, "p.plan.json");
    const marker = join(tmp, "attempt.txt");
    writeFileSync(
      planPath,
      JSON.stringify({
        schemaVersion: "1",
        name: "retry-shell",
        steps: [
          {
            id: "flaky",
            kind: "shell",
            command: process.execPath,
            args: [
              "-e",
              [
                "const fs = require('node:fs')",
                `const marker = ${JSON.stringify(marker)}`,
                "const attempt = fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) + 1 : 1",
                "fs.writeFileSync(marker, String(attempt))",
                "process.exit(attempt === 2 ? 0 : 7)",
              ].join("; "),
            ],
            retries: 1,
          },
        ],
      }),
    );
    const envelope = await runRunCommand({ planPath, env: createNodeEnv(), logDir: join(tmp, "logs"), repoRoot: tmp });
    assert.equal(envelope.ok, true, JSON.stringify(envelope.failure));
    assert.equal(readFileSync(marker, "utf8"), "2");
  });

  it("writes a JSONL log next to the run with all step boundaries", async () => {
    const planPath = join(tmp, "p.plan.json");
    writeFileSync(
      planPath,
      JSON.stringify({
        schemaVersion: "1",
        name: "log-shape",
        steps: [
          { id: "s1", kind: "shell", command: process.execPath, args: ["-e", "console.log('hi')"] },
        ],
      }),
    );
    const env = createNodeEnv();
    const envelope = await runRunCommand({ planPath, env, logDir: join(tmp, "logs"), repoRoot: tmp });
    assert.equal(envelope.ok, true);
    const raw = readFileSync(envelope.logFile, "utf8");
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l) as { event: string });
    const events = lines.map((l) => l.event);
    assert.ok(events.includes("run.start"));
    assert.ok(events.includes("plan.start"));
    assert.ok(events.includes("step.start"));
    assert.ok(events.includes("step.end"));
    assert.ok(events.includes("plan.end"));
    assert.ok(events.includes("run.end"));
  });

  it("defaults command logs to the per-user Bankai home, not the current repo", async () => {
    const home = join(tmp, "home");
    const repoRoot = join(tmp, "repo");
    mkdirSync(repoRoot, { recursive: true });
    const planPath = join(tmp, "p.plan.json");
    writeFileSync(
      planPath,
      JSON.stringify({
        schemaVersion: "1",
        name: "home-logs",
        steps: [
          { id: "ok", kind: "shell", command: process.execPath, args: ["-e", "process.exit(0)"] },
        ],
      }),
    );
    const baseEnv = createNodeEnv();
    const env = { ...baseEnv, home, cwd: repoRoot };
    const envelope = await runRunCommand({ planPath, env, repoRoot });
    assert.equal(envelope.ok, true, JSON.stringify(envelope.failure));
    assert.match(envelope.logFile, /[\\/]home[\\/]\.bankai[\\/]logs[\\/]run-home-logs-/);
  });

  it("reports a structured load-plan failure for malformed plans", async () => {
    const planPath = join(tmp, "p.plan.json");
    writeFileSync(planPath, "{ not valid json");
    const envelope = await runRunCommand({ planPath, env: createNodeEnv(), logDir: join(tmp, "logs"), repoRoot: tmp });
    assert.equal(envelope.ok, false);
    assert.equal(envelope.failure?.stage, "load-plan");
  });

  it("requires declared bindings before any step executes", async () => {
    const planPath = join(tmp, "p.plan.json");
    writeFileSync(
      planPath,
      JSON.stringify({
        schemaVersion: "1",
        name: "needs-binding",
        requires: { bindings: { workspace: { type: "path", required: true } } },
        steps: [
          { id: "s1", kind: "shell", cwd: { binding: "workspace" }, command: process.execPath, args: ["-e", "process.exit(0)"] },
        ],
      }),
    );
    const envelope = await runRunCommand({ planPath, env: createNodeEnv(), logDir: join(tmp, "logs"), repoRoot: tmp });
    assert.equal(envelope.ok, false);
    assert.equal(envelope.failure?.stage, "validation");
    assert.match(envelope.failure?.reason ?? "", /missing required binding/);
    assert.equal(envelope.steps.length, 0);
  });

  it("runs with inline generic bindings and binding cwd references", async () => {
    const workspace = join(tmp, "workspace");
    const planPath = join(tmp, "p.plan.json");
    writeFileSync(
      planPath,
      JSON.stringify({
        schemaVersion: "1",
        name: "bound-cwd",
        requires: { bindings: { workspace: { type: "path", required: true } } },
        steps: [
          {
            id: "pwd",
            kind: "shell",
            cwd: { binding: "workspace" },
            command: process.execPath,
            args: ["-e", "process.stdout.write(process.cwd())"],
          },
        ],
      }),
    );
    const { mkdirSync } = await import("node:fs");
    mkdirSync(workspace);
    const envelope = await runRunCommand({
      planPath,
      env: createNodeEnv(),
      logDir: join(tmp, "logs"),
      repoRoot: tmp,
      bindingsJson: JSON.stringify([{ key: "workspace", value: workspace }]),
    });
    assert.equal(envelope.ok, true, JSON.stringify(envelope.failure));
    assert.equal(envelope.steps[0].shell?.stdoutTail.trim(), workspace);
  });

  it("composes sub-plans with run-plan", async () => {
    const childPath = join(tmp, "child.plan.json");
    writeFileSync(
      childPath,
      JSON.stringify({
        schemaVersion: "1",
        name: "child",
        steps: [
          { id: "child-shell", kind: "shell", command: process.execPath, args: ["-e", "process.stdout.write('child ok')"] },
        ],
      }),
    );
    const parentPath = join(tmp, "parent.plan.json");
    writeFileSync(
      parentPath,
      JSON.stringify({
        schemaVersion: "1",
        name: "parent",
        steps: [
          { id: "run-child", kind: "run-plan", plan: childPath },
        ],
      }),
    );
    const envelope = await runRunCommand({ planPath: parentPath, env: createNodeEnv(), logDir: join(tmp, "logs"), repoRoot: tmp });
    assert.equal(envelope.ok, true, JSON.stringify(envelope.failure));
    assert.equal(envelope.steps.length, 1);
    assert.equal(envelope.steps[0].runPlan?.planName, "child");
  });
});
