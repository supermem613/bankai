import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { BindingsArraySchema } from "../../src/bindings.js";
import { BankaiPlanV1Schema } from "../../src/plan/schema.js";
import { registerTool } from "../../src/tools/registry.js";
import "../../src/steps/index.js";
import "../../src/assertions/index.js";
import "../../src/environments/index.js";
import "../../src/tools/index.js";
import "../../src/readiness/index.js";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

registerTool({
  kind: "test-tool",
  configSchema: z.object({ enabled: z.boolean().default(true) }).strict(),
  invocationSchema: z.object({ input: z.string().min(1) }).strict(),
  doctor: async () => [],
  invoke: async () => ({ ok: true, durationMs: 0, stdout: "", stderr: "" }),
});

function parsePlan(plan: unknown) {
  return BankaiPlanV1Schema.safeParse(plan);
}

function messages(result: ReturnType<typeof parsePlan>): string[] {
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
}

function assertRejectsWith(result: ReturnType<typeof parsePlan>, fragment: string): void {
  assert.ok(!result.success, "expected plan validation to fail");
  assert.ok(messages(result).some((message) => message.includes(fragment)), messages(result).join("\n"));
}

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

  it("accepts required generic binding declarations", () => {
    const r = BankaiPlanV1Schema.safeParse({
      schemaVersion: "1",
      name: "p",
      requires: {
        bindings: {
          workspace: { type: "path", required: true },
          devPort: { type: "number", required: false, default: 3000 },
          targetUrl: { type: "url", required: false },
        },
      },
      steps: [{ id: "s1", kind: "shell", cwd: { binding: "workspace" }, command: "node", args: ["-v"] }],
    });
    assert.ok(r.success, JSON.stringify(r.success ? null : r.error.issues));
  });

  it("accepts binding refs in shell args and write-file steps", () => {
    const r = BankaiPlanV1Schema.safeParse({
      schemaVersion: "1",
      name: "generic-cli",
      requires: {
        bindings: {
          workspace: { type: "path", required: true },
          siteUrl: { type: "url", required: true },
        },
      },
      steps: [
        {
          id: "write-prompt",
          kind: "write-file",
          file: { binding: "workspace", path: "prompt.txt" },
          content: "hello",
        },
        {
          id: "run-cli",
          kind: "shell",
          command: "kash",
          args: ["start", { binding: "siteUrl" }, { fileText: { binding: "workspace", path: "prompt.txt" } }, true, 3],
          stdoutFile: { binding: "workspace", path: "response.json" },
          alwaysRun: true,
        },
      ],
    });
    assert.ok(r.success, JSON.stringify(r.success ? null : r.error.issues));
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

  it("accepts generic text and JSON assertions", () => {
    const r = BankaiPlanV1Schema.safeParse({
      schemaVersion: "1",
      name: "assertions",
      steps: [
        { id: "write", kind: "write-file", file: "response.json", content: "{\"text\":\"hello\",\"toolDetails\":[{\"toolName\":\"x\",\"success\":true}]}" },
        {
          id: "json",
          kind: "assert",
          assertion: "assert-json",
          config: {
            file: "response.json",
            path: ["toolDetails"],
            arrayContainsObject: { toolName: "x", success: true },
          },
        },
        {
          id: "text",
          kind: "assert",
          assertion: "assert-text",
          config: { file: "response.json", contains: "hello", notContains: "goodbye" },
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

  it("accepts attached-process step", () => {
    const r = BankaiPlanV1Schema.safeParse({
      schemaVersion: "1",
      name: "p",
      steps: [{ id: "dev", kind: "attached-process", command: "node", args: ["server.js"] }],
    });
    assert.ok(r.success, JSON.stringify(r.success ? null : r.error.issues));
  });

  it("rejects unknown top-level plan keys", () => {
    assertRejectsWith(parsePlan({
      schemaVersion: "1",
      name: "p",
      unexpected: true,
      steps: [{ id: "s1", kind: "shell", command: "node" }],
    }), "Unrecognized key");
  });

  it("rejects unknown requires keys", () => {
    assertRejectsWith(parsePlan({
      schemaVersion: "1",
      name: "p",
      requires: { bindings: {}, extra: true },
      steps: [{ id: "s1", kind: "shell", command: "node" }],
    }), "requires: Unrecognized key");
  });

  it("rejects unknown binding requirement keys", () => {
    assertRejectsWith(parsePlan({
      schemaVersion: "1",
      name: "p",
      requires: { bindings: { workspace: { type: "path", extra: true } } },
      steps: [{ id: "s1", kind: "shell", command: "node" }],
    }), "requires.bindings.workspace: Unrecognized key");
  });

  it("rejects unknown binding array entry keys", () => {
    const result = BindingsArraySchema.safeParse([{ key: "workspace", value: ".", extra: true }]);
    assert.ok(!result.success);
    assert.ok(result.error.issues.some((issue) => issue.message.includes("Unrecognized key")));
  });

  it("rejects unknown keys on binding path refs", () => {
    assertRejectsWith(parsePlan({
      schemaVersion: "1",
      name: "p",
      steps: [{ id: "s1", kind: "shell", cwd: { binding: "workspace", extra: true }, command: "node" }],
    }), "steps.0.cwd: Unrecognized key");
  });

  it("rejects unknown keys on every built-in step kind", () => {
    const cases: Array<[string, unknown]> = [
      ["shell", { id: "shell", kind: "shell", command: "node", extra: true }],
      ["setup", { id: "setup", kind: "setup", env: "noop", extra: true }],
      ["wait", { id: "wait", kind: "wait", fromRegistry: "svc", for: [{ kind: "port", id: "p1", port: 1 }], extra: true }],
      ["assert", { id: "assert", kind: "assert", assertion: "step-output-contains", config: { stepId: "shell", text: "x" }, extra: true }],
      ["tool", { id: "tool", kind: "tool", tool: "test-tool", invocation: { input: "p.txt" }, extra: true }],
      ["run-plan", { id: "run-plan", kind: "run-plan", plan: "child.json", extra: true }],
      ["write-file", { id: "write-file", kind: "write-file", file: "out.txt", content: "hello", extra: true }],
      ["stop", { id: "stop", kind: "stop", name: "svc", extra: true }],
      ["attached-process", { id: "attached-process", kind: "attached-process", command: "node", extra: true }],
    ];

    for (const [kind, step] of cases) {
      assertRejectsWith(parsePlan({
        schemaVersion: "1",
        name: `p-${kind}`,
        steps: [step],
      }), "Unrecognized key");
    }
  });

  it("rejects unknown keys in environment plugin config", () => {
    assertRejectsWith(parsePlan({
      schemaVersion: "1",
      name: "p",
      steps: [{ id: "s1", kind: "setup", env: "noop", config: { extra: true } }],
    }), "config: Unrecognized key");
  });

  it("rejects unknown keys in tool config and invocation", () => {
    const badConfig = parsePlan({
      schemaVersion: "1",
      name: "p",
      steps: [{ id: "t1", kind: "tool", tool: "test-tool", config: { extra: true }, invocation: { input: "p.txt" } }],
    });
    assertRejectsWith(badConfig, "config: Unrecognized key");

    const badInvocation = parsePlan({
      schemaVersion: "1",
      name: "p",
      steps: [{ id: "t1", kind: "tool", tool: "test-tool", invocation: { input: "p.txt", extra: true } }],
    });
    assertRejectsWith(badInvocation, "invocation: Unrecognized key");
  });

  it("rejects unknown keys in assertion config", () => {
    assertRejectsWith(parsePlan({
      schemaVersion: "1",
      name: "p",
      steps: [
        { id: "s1", kind: "shell", command: "node" },
        { id: "a1", kind: "assert", assertion: "step-output-contains", config: { stepId: "s1", text: "v", extra: true } },
      ],
    }), "config: Unrecognized key");
  });

  it("rejects readiness probe typos during plan validation", () => {
    assertRejectsWith(parsePlan({
      schemaVersion: "1",
      name: "p",
      steps: [{ id: "w1", kind: "wait", fromRegistry: "svc", for: [{ kind: "port", id: "p1", port: 1, tiemoutMs: 1 }] }],
    }), "for.0: Unrecognized key");
  });

  it("rejects unknown readiness probe kinds during plan validation", () => {
    assertRejectsWith(parsePlan({
      schemaVersion: "1",
      name: "p",
      steps: [{ id: "w1", kind: "wait", fromRegistry: "svc", for: [{ kind: "no-such-probe", id: "p1" }] }],
    }), "unknown readiness probe kind");
  });

  it("accepts omitted fields that have defaults", () => {
    const result = parsePlan({
      schemaVersion: "1",
      name: "p",
      steps: [
        { id: "s1", kind: "shell", command: "node" },
        { id: "w1", kind: "wait", fromRegistry: "svc", for: [{ kind: "port", id: "p1", port: 1 }] },
        { id: "st", kind: "stop", name: "svc" },
      ],
    });
    assert.ok(result.success, JSON.stringify(result.success ? null : result.error.issues));
  });

  it("parses every bundled skill plan JSON", () => {
    for (const skill of ["test", "dev-loop"]) {
      const plansDir = join(repoRoot, ".claude", "skills", skill, "plans");
      for (const file of readdirSync(plansDir).filter((entry) => entry.endsWith(".json"))) {
        const plan = JSON.parse(readFileSync(join(plansDir, file), "utf8")) as unknown;
        const result = parsePlan(plan);
        assert.ok(result.success, `${skill}/${file}: ${messages(result).join("\n")}`);
      }
    }
  });
});
