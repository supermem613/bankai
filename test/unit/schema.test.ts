import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { ScenarioV1Schema } from "../../src/schema/scenario.js";
import { ShellStepV1Schema } from "../../src/steps/shell.js";
import { StepOutputContainsAssertionV1Schema } from "../../src/assertions/step-output-contains.js";

// Schema validation tests. INVARIANT: schemaVersion is the discriminant. A
// future ScenarioV2 must NOT be silently parsed as V1. The literal("1") in
// the schema is the load-bearing piece.

describe("ScenarioV1Schema", () => {
  it("accepts a minimal valid scenario", () => {
    const result = ScenarioV1Schema.safeParse({
      schemaVersion: "1",
      name: "minimal",
    });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.steps.length, 0);
      assert.equal(result.data.assertions.length, 0);
    }
  });

  it("rejects missing schemaVersion", () => {
    const result = ScenarioV1Schema.safeParse({ name: "x" });
    assert.equal(result.success, false);
  });

  it("rejects schemaVersion that is not the literal \"1\"", () => {
    const r1 = ScenarioV1Schema.safeParse({ schemaVersion: "2", name: "x" });
    assert.equal(r1.success, false);
    const r2 = ScenarioV1Schema.safeParse({ schemaVersion: 1, name: "x" });
    assert.equal(r2.success, false);
  });

  it("rejects empty name", () => {
    const result = ScenarioV1Schema.safeParse({ schemaVersion: "1", name: "" });
    assert.equal(result.success, false);
  });

  it("preserves unknown fields on steps and assertions for handler validation", () => {
    const result = ScenarioV1Schema.safeParse({
      schemaVersion: "1",
      name: "passthrough",
      steps: [{ kind: "shell", id: "s1", command: "node", args: ["-v"] }],
      assertions: [{ kind: "step-output-contains", id: "a1", stepId: "s1", text: "v" }],
    });
    assert.equal(result.success, true);
    if (result.success) {
      const stepRecord = result.data.steps[0] as Record<string, unknown>;
      assert.equal(stepRecord.command, "node");
    }
  });
});

describe("ShellStepV1Schema", () => {
  it("accepts a valid shell step with defaults", () => {
    const result = ShellStepV1Schema.safeParse({
      kind: "shell",
      id: "s1",
      command: "node",
    });
    assert.equal(result.success, true);
    if (result.success) {
      assert.deepEqual(result.data.args, []);
      assert.equal(result.data.timeoutMs, 30000);
      assert.equal(result.data.expectExitCode, 0);
    }
  });

  it("rejects missing command", () => {
    const result = ShellStepV1Schema.safeParse({ kind: "shell", id: "s1" });
    assert.equal(result.success, false);
  });

  it("rejects negative timeoutMs", () => {
    const result = ShellStepV1Schema.safeParse({
      kind: "shell",
      id: "s1",
      command: "node",
      timeoutMs: -1,
    });
    assert.equal(result.success, false);
  });

  it("rejects non-integer timeoutMs", () => {
    const result = ShellStepV1Schema.safeParse({
      kind: "shell",
      id: "s1",
      command: "node",
      timeoutMs: 1.5,
    });
    assert.equal(result.success, false);
  });
});

describe("StepOutputContainsAssertionV1Schema", () => {
  it("accepts a valid assertion with default stream", () => {
    const result = StepOutputContainsAssertionV1Schema.safeParse({
      kind: "step-output-contains",
      id: "a1",
      stepId: "s1",
      text: "hello",
    });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.stream, "stdout");
    }
  });

  it("rejects unknown stream", () => {
    const result = StepOutputContainsAssertionV1Schema.safeParse({
      kind: "step-output-contains",
      id: "a1",
      stepId: "s1",
      stream: "syslog",
      text: "hello",
    });
    assert.equal(result.success, false);
  });

  it("rejects empty text", () => {
    const result = StepOutputContainsAssertionV1Schema.safeParse({
      kind: "step-output-contains",
      id: "a1",
      stepId: "s1",
      text: "",
    });
    assert.equal(result.success, false);
  });
});
