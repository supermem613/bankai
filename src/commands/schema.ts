import { bindingsSchemaDocument } from "../bindings.js";

export type SchemaKind = "plan" | "bindings";

export function schemaDocument(kind: SchemaKind): unknown {
  if (kind === "bindings") {
    return bindingsSchemaDocument();
  }
  return {
    description: "Bankai plan schema. Plans are portable executable instructions. Machine-specific values are declared in requires.bindings and supplied at run time.",
    plan: {
      schemaVersion: "1",
      name: "example-plan",
      description: "Optional summary",
      requires: {
        bindings: {
          workspace: { type: "path", required: true },
          targetUrl: { type: "url", required: false },
          devPort: { type: "number", required: false, default: 3000 },
        },
      },
      steps: [
        {
          kind: "attached-process",
          id: "dev",
          cwd: { binding: "workspace" },
          command: "npm",
          args: ["run", "dev"],
        },
      ],
    },
    bindingTypes: ["string", "number", "boolean", "path", "url"],
    bindingReference: {
      cwd: { binding: "workspace", path: "optional-subdir" },
    },
  };
}
