import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { normalizeSchemaKind, schemaDocument } from "../../src/commands/schema.js";

describe("schema command", () => {
  it("defaults to the Bankai command surface", () => {
    const doc = schemaDocument() as { commands?: Array<{ name: string; usage: string; options?: Array<{ name: string }> }> };

    assert.deepEqual(doc.commands?.map((command) => command.name), [
      "run",
      "status",
      "logs",
      "stop",
      "doctor",
      "update",
      "schema",
    ]);
    assert.ok(doc.commands?.some((command) => command.usage === "bankai schema [commands|plan|bindings]"));
    assert.ok(doc.commands?.every((command) => !command.options?.some((option) => option.name.startsWith("--json"))));
  });

  it("keeps plan and bindings schemas available by explicit kind", () => {
    assert.ok((schemaDocument("plan") as { plan?: unknown }).plan);
    assert.ok((schemaDocument("bindings") as { arrayShape?: unknown }).arrayShape);
  });

  it("normalizes schema aliases and rejects unknown kinds", () => {
    assert.equal(normalizeSchemaKind(undefined), "commands");
    assert.equal(normalizeSchemaKind("command"), "commands");
    assert.equal(normalizeSchemaKind("commands"), "commands");
    assert.equal(normalizeSchemaKind("plan"), "plan");
    assert.equal(normalizeSchemaKind("bindings"), "bindings");
    assert.equal(normalizeSchemaKind("nope"), undefined);
  });
});
