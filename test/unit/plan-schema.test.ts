import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { BankaiPlanV1Schema } from "../../src/plan/schema.js";
import "../../src/steps/index.js";
import "../../src/assertions/index.js";
import "../../src/environments/index.js";
import "../../src/tools/index.js";
import "../../src/readiness/index.js";

describe("plan schema", () => {
  it("accepts a minimal shell-only plan", () => {
    const r = BankaiPlanV1Schema.safeParse({
      schemaVersion: "1",
      name: "p",
      steps: [{ id: "s1", kind: "shell", command: "node", args: ["-v"] }],
    });
    assert.ok(r.success, JSON.stringify(r.success ? null : r.error.issues));
    assert.equal(r.data.steps.length, 1);
  });

  it("rejects an unknown step kind with a clear message", () => {
    const r = BankaiPlanV1Schema.safeParse({
      schemaVersion: "1",
      name: "p",
      steps: [{ id: "s1", kind: "unknown-thing" }],
    });
    assert.ok(!r.success);
    const msgs = r.success ? [] : r.error.issues.map((i) => i.message);
    assert.ok(msgs.some((m) => m.includes("unknown step kind")));
  });

  it("rejects duplicate step ids", () => {
    const r = BankaiPlanV1Schema.safeParse({
      schemaVersion: "1",
      name: "p",
      steps: [
        { id: "s1", kind: "shell", command: "node" },
        { id: "s1", kind: "shell", command: "node" },
      ],
    });
    assert.ok(!r.success);
    const msgs = r.success ? [] : r.error.issues.map((i) => i.message);
    assert.ok(msgs.some((m) => m.includes("duplicate step id")));
  });

  it("validates wait step needs fromStepId or fromRegistry", () => {
    const r = BankaiPlanV1Schema.safeParse({
      schemaVersion: "1",
      name: "p",
      steps: [{ id: "w1", kind: "wait", for: [{ kind: "port", id: "p1", port: 1 }] }],
    });
    assert.ok(!r.success);
    const msgs = r.success ? [] : r.error.issues.map((i) => i.message);
    assert.ok(msgs.some((m) => m.includes("fromStepId or fromRegistry")));
  });

  it("rejects wait step with both fromStepId and fromRegistry", () => {
    const r = BankaiPlanV1Schema.safeParse({
      schemaVersion: "1",
      name: "p",
      steps: [
        {
          id: "w1",
          kind: "wait",
          fromStepId: "x",
          fromRegistry: "y",
          for: [{ kind: "port", id: "p1", port: 1 }],
        },
      ],
    });
    assert.ok(!r.success);
  });

  it("validates an assert step against its assertion plugin", () => {
    const r = BankaiPlanV1Schema.safeParse({
      schemaVersion: "1",
      name: "p",
      steps: [
        { id: "s1", kind: "shell", command: "node", args: ["-v"] },
        {
          id: "a1",
          kind: "assert",
          assertion: "step-output-contains",
          config: { stepId: "s1", text: "v" },
        },
      ],
    });
    assert.ok(r.success, JSON.stringify(r.success ? null : r.error.issues));
  });

  it("validates a setup step against its env plugin", () => {
    const r = BankaiPlanV1Schema.safeParse({
      schemaVersion: "1",
      name: "p",
      steps: [
        { id: "s1", kind: "setup", env: "noop" },
      ],
    });
    assert.ok(r.success);
  });

  it("rejects a setup step with unknown env kind", () => {
    const r = BankaiPlanV1Schema.safeParse({
      schemaVersion: "1",
      name: "p",
      steps: [{ id: "s1", kind: "setup", env: "no-such-env" }],
    });
    assert.ok(!r.success);
    const msgs = r.success ? [] : r.error.issues.map((i) => i.message);
    assert.ok(msgs.some((m) => m.includes("unknown environment kind")));
  });

  it("accepts run-plan step", () => {
    const r = BankaiPlanV1Schema.safeParse({
      schemaVersion: "1",
      name: "p",
      steps: [{ id: "rp", kind: "run-plan", plan: "./other.json" }],
    });
    assert.ok(r.success);
  });

  it("accepts stop step", () => {
    const r = BankaiPlanV1Schema.safeParse({
      schemaVersion: "1",
      name: "p",
      steps: [{ id: "st", kind: "stop", name: "svc" }],
    });
    assert.ok(r.success);
  });
});
