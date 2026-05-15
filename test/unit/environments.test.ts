import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import {
  registerEnvironment,
  getEnvironment,
  listEnvironments,
} from "../../src/environments/registry.js";
import { createLifecycleScope } from "../../src/environments/lifecycle-scope.js";
import type { EnvironmentPlugin } from "../../src/environments/interface.js";
import { noopPlugin } from "../../src/environments/noop.js";
import { createNodeEnv } from "../../src/env-runtime/env.js";
import "../../src/environments/index.js";

test("noop plugin: doctor returns ok", async () => {
  const checks = await noopPlugin.doctor(createNodeEnv());
  assert.equal(checks.length, 1);
  assert.equal(checks[0].ok, true);
});

test("noop plugin: setup returns ready capabilities", async () => {
  const scope = createLifecycleScope();
  const ctrl = new AbortController();
  const handle = await noopPlugin.setup(
    {
      env: createNodeEnv(),
      workDir: ".",
      scenarioName: "unit",
      scope,
      signal: ctrl.signal,
      timeoutMs: 1000,
    },
    {},
  );
  assert.equal(handle.capabilities.ready, true);
  await handle.teardown();
});

test("registry: register adds plugin and rejects duplicates", () => {
  const kind = "unit-fake-" + Math.random().toString(36).slice(2, 8);
  const fake: EnvironmentPlugin<z.ZodObject<Record<string, never>>, Record<string, never>> = {
    kind,
    configSchema: z.object({}),
    async doctor() {
      return [];
    },
    async setup() {
      return { capabilities: {}, async teardown() {} };
    },
  };
  registerEnvironment(fake);
  assert.equal(getEnvironment(kind), fake);
  assert.throws(() => registerEnvironment(fake), /already registered/);
});

test("registry: list returns sorted kinds and includes noop", () => {
  const kinds = listEnvironments();
  assert.ok(kinds.includes("noop"));
  const sorted = [...kinds].sort();
  assert.deepEqual(kinds, sorted);
});

test("registry: getEnvironment returns undefined for unknown kind", () => {
  const result = getEnvironment("definitely-not-registered-zzz");
  assert.equal(result, undefined);
});

test("lifecycle scope: empty unwind is safe", async () => {
  const scope = createLifecycleScope();
  await scope.unwind();
});

test("lifecycle scope: cleanup error is forwarded to onCleanupError", async () => {
  const errors: unknown[] = [];
  const scope = createLifecycleScope({
    onCleanupError: (err) => {
      errors.push(err);
    },
  });
  scope.defer(() => {
    throw new Error("first-boom");
  });
  scope.defer(() => {
    throw new Error("second-boom");
  });
  await scope.unwind();
  assert.equal(errors.length, 2);
  assert.match(String(errors[0]), /second-boom/);
  assert.match(String(errors[1]), /first-boom/);
});
