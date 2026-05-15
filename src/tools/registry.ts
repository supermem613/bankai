import type { z } from "zod";
import type { ToolPlugin } from "./interface.js";

// Tool plugin registry. Mirrors the environment registry pattern: open set,
// global registration at module load, listed by kind. Invariants the next
// editor must preserve:
//   1. Registration happens at the top level of each plugin file. Importing
//      src/tools/index.ts populates the registry as a side effect.
//   2. The tool step kind looks up plugins by kind. An unknown kind aborts
//      at scenario preflight via the tool step's superRefine.
//   3. There is no built-in default tool. Removing all plugins is fine; the
//      tool step kind will fail validation for any reference to a missing
//      kind and steps will not run.

type AnyToolPlugin = ToolPlugin<z.ZodTypeAny, z.ZodTypeAny>;

const registry = new Map<string, AnyToolPlugin>();

export function registerTool<C extends z.ZodTypeAny, I extends z.ZodTypeAny>(
  plugin: ToolPlugin<C, I>,
): void {
  if (registry.has(plugin.kind)) {
    throw new Error(`tool kind already registered: ${plugin.kind}`);
  }
  registry.set(plugin.kind, plugin as AnyToolPlugin);
}

export function getTool(kind: string): AnyToolPlugin | undefined {
  return registry.get(kind);
}

export function listTools(): string[] {
  return [...registry.keys()].sort();
}

export type { ToolPlugin, ToolContext, ToolInvocationResult, CheckResult } from "./interface.js";
