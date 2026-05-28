import { bindingsSchemaDocument } from "../bindings.js";

export type SchemaKind = "commands" | "plan" | "bindings";

export function schemaDocument(kind: SchemaKind = "commands"): unknown {
  if (kind === "commands") {
    return commandSchemaDocument();
  }
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

export function normalizeSchemaKind(kind: string | undefined): SchemaKind | undefined {
  if (kind === undefined || kind === "commands" || kind === "command") {
    return "commands";
  }
  if (kind === "plan" || kind === "bindings") {
    return kind;
  }
  return undefined;
}

function commandSchemaDocument(): unknown {
  return {
    description: "Bankai command schema. This is the agent-facing command surface. Use schema plan or schema bindings for plan-authoring internals.",
    commands: [
      {
        name: "run",
        usage: "bankai run <plan>",
        summary: "Execute a Bankai plan to completion.",
        arguments: [{ name: "plan", required: true, description: "Path to a Bankai plan JSON file." }],
        options: commonEnvelopeOptions([
          { name: "--bindings-file <path>", description: "JSON array of {key,value} bindings or object shorthand." },
          { name: "--bindings-json <json>", description: "Inline JSON array of {key,value} bindings or object shorthand." },
        ]),
        envelope: {
          command: "run",
          fields: ["ok", "steps", "failure", "registry", "logFile", "planName", "planPath"],
        },
      },
      {
        name: "status",
        usage: "bankai status [name]",
        summary: "Read concise registered-handle state.",
        arguments: [{ name: "name", required: false, description: "Optional registered handle name." }],
        options: commonEnvelopeOptions(),
        envelope: {
          command: "status",
          fields: ["ok", "registry", "logFile"],
        },
      },
      {
        name: "logs",
        usage: "bankai logs [name]",
        summary: "Read detailed run and transcript log tails for registered handles.",
        arguments: [{ name: "name", required: false, description: "Optional registered handle name." }],
        options: commonEnvelopeOptions(),
        envelope: {
          command: "logs",
          fields: ["ok", "registry", "logFile"],
        },
      },
      {
        name: "stop",
        usage: "bankai stop <name>",
        summary: "Stop a registered handle by name.",
        arguments: [{ name: "name", required: true, description: "Registered handle name." }],
        options: commonEnvelopeOptions([
          { name: "--force", description: "Kill even if the fingerprint does not match." },
          { name: "--grace-ms <n>", description: "Milliseconds to wait between graceful stop and escalation." },
        ]),
        envelope: {
          command: "stop",
          fields: ["ok", "registry", "steps", "failure", "logFile"],
        },
      },
      {
        name: "doctor",
        usage: "bankai doctor [--plan <path>] [--prune]",
        summary: "Run health checks, optional plan validation, and stale-state pruning.",
        arguments: [],
        options: commonEnvelopeOptions([
          { name: "--plan <path>", description: "Validate a plan file in addition to base checks." },
          { name: "--prune", description: "Remove stale registry entries and stale lock files." },
        ]),
        envelope: {
          command: "doctor",
          fields: ["ok", "checks", "failure", "logFile"],
        },
      },
      {
        name: "update",
        usage: "bankai update",
        summary: "Self-update this Bankai git checkout.",
        arguments: [],
        options: commonEnvelopeOptions(),
        envelope: {
          command: "update",
          fields: ["ok", "steps", "failure", "logFile"],
        },
      },
      {
        name: "schema",
        usage: "bankai schema [commands|plan|bindings]",
        summary: "Print the Bankai command schema by default, or plan/bindings authoring schemas explicitly.",
        arguments: [{ name: "kind", required: false, description: "commands, plan, or bindings. Defaults to commands." }],
        options: [],
        envelope: null,
      },
    ],
  };
}

function commonEnvelopeOptions(extra: Array<{ name: string; description: string }> = []): Array<{ name: string; description: string }> {
  return [
    { name: "--log-dir <path>", description: "Directory to write the JSONL command log into." },
    { name: "--log-file <path>", description: "Explicit JSONL log file path." },
    { name: "--out <path>", description: "Also write the envelope JSON to this path." },
    ...extra,
  ];
}
