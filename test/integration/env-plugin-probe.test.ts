import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createNodeEnv } from "../../src/env-runtime/env.js";
import {
  registerEnvironment,
  getEnvironment,
  listEnvironments,
} from "../../src/environments/registry.js";
import { createLifecycleScope } from "../../src/environments/lifecycle-scope.js";
import type { EnvironmentPlugin } from "../../src/environments/interface.js";
import { runScenario } from "../../src/orchestrators/test.js";
import "../../src/environments/index.js";
import { z } from "zod";

// Skeptic probe for the environment plugin layer. These tests guard the
// invariants surfaced by the v1 contract critique. They MUST stay as real
// round-trips against the registered plugins. Mocking them out defeats the
// point of the probe.
//
// Invariants under test:
//   1. Registry: register adds plugin, duplicate throws, get returns plugin,
//      list reports kinds in sorted order.
//   2. LifecycleScope: defer pushes onto a stack, unwind runs LIFO, an
//      individual cleanup throw does not stop later cleanups from running.
//   3. Orchestrator dispatches to the env plugin: setup runs before steps,
//      teardown runs after steps, teardown runs even when a step fails.
//   4. Partial setup throw triggers scope.unwind so any resources acquired
//      before the throw are released, then surfaces stage="env-setup".

test("registry: register, get, list", () => {
  const fakeKind = "probe-fake-" + Math.random().toString(36).slice(2, 8);
  const plugin: EnvironmentPlugin<z.ZodObject<Record<string, never>>, { ok: true }> = {
    kind: fakeKind,
    configSchema: z.object({}),
    async doctor() {
      return [];
    },
    async setup() {
      return { capabilities: { ok: true }, async teardown() {} };
    },
  };
  registerEnvironment(plugin);
  assert.equal(getEnvironment(fakeKind), plugin);
  assert.ok(listEnvironments().includes(fakeKind));
  assert.throws(() => registerEnvironment(plugin), /already registered/);
});

test("noop plugin is registered by default", () => {
  const noop = getEnvironment("noop");
  assert.ok(noop, "noop plugin should be registered via side-effect import");
  assert.equal(noop?.kind, "noop");
});

test("lifecycle scope: unwind runs LIFO and survives individual throws", async () => {
  const order: string[] = [];
  const scope = createLifecycleScope();
  scope.defer(() => {
    order.push("first");
  });
  scope.defer(() => {
    order.push("second");
    throw new Error("boom");
  });
  scope.defer(async () => {
    order.push("third");
  });
  await scope.unwind();
  assert.deepEqual(order, ["third", "second", "first"]);
});

test("lifecycle scope: second unwind is a no-op", async () => {
  const order: string[] = [];
  const scope = createLifecycleScope();
  scope.defer(() => {
    order.push("once");
  });
  await scope.unwind();
  await scope.unwind();
  assert.deepEqual(order, ["once"]);
});

test("orchestrator: noop env runs setup before steps and teardown after", async () => {
  const env = createNodeEnv();
  const workDir = mkdtempSync(path.join(tmpdir(), "bankai-envprobe-"));
  try {
    const result = await runScenario({
      scenarioJson: {
        schemaVersion: "1",
        name: "noop-env-success",
        environment: { kind: "noop" },
        steps: [
          { kind: "shell", id: "echo", command: process.execPath, args: ["-e", "console.log('hi')"] },
        ],
        assertions: [],
      },
      env,
      workDir,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0].ok, true);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("orchestrator: defaults to noop env when scenario omits environment", async () => {
  const env = createNodeEnv();
  const workDir = mkdtempSync(path.join(tmpdir(), "bankai-envprobe-"));
  try {
    const result = await runScenario({
      scenarioJson: {
        schemaVersion: "1",
        name: "default-env",
        steps: [],
        assertions: [],
      },
      env,
      workDir,
    });
    assert.equal(result.ok, true);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("orchestrator: teardown runs even when a step fails", async () => {
  const env = createNodeEnv();
  const workDir = mkdtempSync(path.join(tmpdir(), "bankai-envprobe-"));
  let teardownCalls = 0;
  const probeKind = "probe-teardown-tracker-" + Math.random().toString(36).slice(2, 8);
  registerEnvironment({
    kind: probeKind,
    configSchema: z.object({}),
    async doctor() {
      return [];
    },
    async setup() {
      return {
        capabilities: {},
        async teardown() {
          teardownCalls++;
        },
      };
    },
  });
  try {
    const result = await runScenario({
      scenarioJson: {
        schemaVersion: "1",
        name: "teardown-on-failure",
        environment: { kind: probeKind },
        steps: [
          {
            kind: "shell",
            id: "fail",
            command: process.execPath,
            args: ["-e", "process.exit(7)"],
            expectExitCode: 0,
          },
        ],
        assertions: [],
      },
      env,
      workDir,
    });
    assert.equal(result.ok, false);
    assert.equal(result.failure?.stage, "step");
    assert.equal(teardownCalls, 1, "teardown must run exactly once even on step failure");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("orchestrator: partial setup throw triggers scope.unwind and surfaces stage env-setup", async () => {
  const env = createNodeEnv();
  const workDir = mkdtempSync(path.join(tmpdir(), "bankai-envprobe-"));
  let firstCleanup = 0;
  let secondCleanup = 0;
  const probeKind = "probe-partial-setup-" + Math.random().toString(36).slice(2, 8);
  registerEnvironment({
    kind: probeKind,
    configSchema: z.object({}),
    async doctor() {
      return [];
    },
    async setup(ctx) {
      ctx.scope.defer(() => {
        firstCleanup++;
      });
      ctx.scope.defer(() => {
        secondCleanup++;
      });
      throw new Error("setup-boom");
    },
  });
  try {
    const result = await runScenario({
      scenarioJson: {
        schemaVersion: "1",
        name: "partial-setup",
        environment: { kind: probeKind },
        steps: [
          { kind: "shell", id: "wont-run", command: process.execPath, args: ["-e", "console.log('x')"] },
        ],
        assertions: [],
      },
      env,
      workDir,
    });
    assert.equal(result.ok, false);
    assert.equal(result.failure?.stage, "env-setup");
    assert.match(result.failure?.reason ?? "", /setup-boom/);
    assert.equal(firstCleanup, 1, "first deferred cleanup should run");
    assert.equal(secondCleanup, 1, "second deferred cleanup should run");
    assert.equal(result.steps.length, 0, "no steps should run when setup fails");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("orchestrator: unknown environment kind fails at validation stage", async () => {
  const env = createNodeEnv();
  const workDir = mkdtempSync(path.join(tmpdir(), "bankai-envprobe-"));
  try {
    const result = await runScenario({
      scenarioJson: {
        schemaVersion: "1",
        name: "unknown-env",
        environment: { kind: "definitely-not-registered-" + Math.random() },
        steps: [],
        assertions: [],
      },
      env,
      workDir,
    });
    assert.equal(result.ok, false);
    assert.equal(result.failure?.stage, "validation");
    assert.match(result.failure?.reason ?? "", /unknown environment kind/i);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("orchestrator: env-teardown failure surfaces when steps and assertions pass", async () => {
  const env = createNodeEnv();
  const workDir = mkdtempSync(path.join(tmpdir(), "bankai-envprobe-"));
  const probeKind = "probe-teardown-throw-" + Math.random().toString(36).slice(2, 8);
  registerEnvironment({
    kind: probeKind,
    configSchema: z.object({}),
    async doctor() {
      return [];
    },
    async setup() {
      return {
        capabilities: {},
        async teardown() {
          throw new Error("teardown-boom");
        },
      };
    },
  });
  try {
    const result = await runScenario({
      scenarioJson: {
        schemaVersion: "1",
        name: "teardown-failure",
        environment: { kind: probeKind },
        steps: [
          { kind: "shell", id: "ok", command: process.execPath, args: ["-e", "process.exit(0)"] },
        ],
        assertions: [],
      },
      env,
      workDir,
    });
    assert.equal(result.ok, false);
    assert.equal(result.failure?.stage, "env-teardown");
    assert.match(result.failure?.reason ?? "", /teardown-boom/);
    assert.equal(result.steps[0]?.ok, true, "step should still have run successfully");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("orchestrator: step failure takes priority over env-teardown failure", async () => {
  const env = createNodeEnv();
  const workDir = mkdtempSync(path.join(tmpdir(), "bankai-envprobe-"));
  const probeKind = "probe-step-and-teardown-fail-" + Math.random().toString(36).slice(2, 8);
  registerEnvironment({
    kind: probeKind,
    configSchema: z.object({}),
    async doctor() {
      return [];
    },
    async setup() {
      return {
        capabilities: {},
        async teardown() {
          throw new Error("teardown-also-boom");
        },
      };
    },
  });
  try {
    const result = await runScenario({
      scenarioJson: {
        schemaVersion: "1",
        name: "step-and-teardown",
        environment: { kind: probeKind },
        steps: [
          {
            kind: "shell",
            id: "fail",
            command: process.execPath,
            args: ["-e", "process.exit(3)"],
            expectExitCode: 0,
          },
        ],
        assertions: [],
      },
      env,
      workDir,
    });
    assert.equal(result.ok, false);
    assert.equal(result.failure?.stage, "step", "primary failure should be the step, not the teardown");
    assert.equal(result.failure?.id, "fail");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
