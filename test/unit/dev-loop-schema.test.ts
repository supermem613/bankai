import { test } from "node:test";
import assert from "node:assert/strict";
import { DevLoopPlanV1Schema } from "../../src/dev-loop/schema.js";
import {
  DevLoopStateFileSchema,
  DevLoopStateEntrySchema,
} from "../../src/dev-loop/envelope.js";

test("DevLoopPlanV1Schema: accepts a minimal valid plan and applies defaults", () => {
  const r = DevLoopPlanV1Schema.safeParse({
    schemaVersion: "1",
    name: "node-http-server",
    environment: { kind: "managed-process", config: { command: "node" } },
  });
  assert.equal(r.success, true);
  if (r.success) {
    assert.deepEqual(r.data.readiness, []);
    assert.equal(r.data.readyTimeoutMs, 180_000);
  }
});

test("DevLoopPlanV1Schema: rejects non-kebab-case name", () => {
  const r = DevLoopPlanV1Schema.safeParse({
    schemaVersion: "1",
    name: "Has_Underscore",
    environment: { kind: "managed-process" },
  });
  assert.equal(r.success, false);
});

test("DevLoopPlanV1Schema: rejects name starting with hyphen", () => {
  const r = DevLoopPlanV1Schema.safeParse({
    schemaVersion: "1",
    name: "-leading-hyphen",
    environment: { kind: "managed-process" },
  });
  assert.equal(r.success, false);
});

test("DevLoopPlanV1Schema: schemaVersion must be the literal \"1\"", () => {
  const r1 = DevLoopPlanV1Schema.safeParse({
    schemaVersion: "2",
    name: "x",
    environment: { kind: "k" },
  });
  assert.equal(r1.success, false);
  const r2 = DevLoopPlanV1Schema.safeParse({
    schemaVersion: 1,
    name: "x",
    environment: { kind: "k" },
  });
  assert.equal(r2.success, false);
});

test("DevLoopPlanV1Schema: rejects missing environment.kind", () => {
  const r = DevLoopPlanV1Schema.safeParse({
    schemaVersion: "1",
    name: "x",
    environment: {},
  });
  assert.equal(r.success, false);
});

test("DevLoopPlanV1Schema: readiness probes pass through unknown fields", () => {
  const r = DevLoopPlanV1Schema.safeParse({
    schemaVersion: "1",
    name: "x",
    environment: { kind: "k" },
    readiness: [{ kind: "port", id: "p1", port: 8080 }],
  });
  assert.equal(r.success, true);
  if (r.success) {
    const probe = r.data.readiness[0] as Record<string, unknown>;
    assert.equal(probe.port, 8080);
  }
});

test("DevLoopStateEntrySchema: rejects pid <= 0", () => {
  const base = {
    schemaVersion: "1",
    planName: "x",
    startedAt: "2024-01-01T00:00:00.000Z",
    pid: 0,
    fingerprint: { creationTime: "x", commandLine: "y" },
    workDir: "/tmp",
    command: "node",
    args: [],
    logFile: "/tmp/x.log",
    logStartOffset: 0,
    envKind: "managed-process",
  };
  const r = DevLoopStateEntrySchema.safeParse(base);
  assert.equal(r.success, false);
});

test("DevLoopStateFileSchema: defaults entries to empty record when absent", () => {
  const r = DevLoopStateFileSchema.safeParse({ schemaVersion: "1" });
  assert.equal(r.success, true);
  if (r.success) {
    assert.deepEqual(r.data.entries, {});
  }
});
