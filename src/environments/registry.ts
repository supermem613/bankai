import type { z } from "zod";
import type { EnvironmentPlugin } from "./interface.js";

// Environment plugin registry. Mirrors the step and assertion registries.
// Invariants the next editor must preserve:
//   1. Registration is global at module load. Built-in plugins call register
//      from their top level so importing the index registers everything.
//   2. The registry is the source of truth for "valid environment kind". The
//      orchestrator looks up the kind during preflight validation. An unknown
//      kind aborts before any side effect.
//   3. The "noop" kind is reserved for the testing environment and must
//      always be registered. Removing it breaks the default scenario shape.

type AnyEnvironmentPlugin = EnvironmentPlugin<z.ZodTypeAny, unknown>;

const registry = new Map<string, AnyEnvironmentPlugin>();

export function registerEnvironment<C extends z.ZodTypeAny, Caps>(
  plugin: EnvironmentPlugin<C, Caps>,
): void {
  if (registry.has(plugin.kind)) {
    throw new Error(`environment kind already registered: ${plugin.kind}`);
  }
  registry.set(plugin.kind, plugin as AnyEnvironmentPlugin);
}

export function getEnvironment(kind: string): AnyEnvironmentPlugin | undefined {
  return registry.get(kind);
}

export function listEnvironments(): string[] {
  return [...registry.keys()].sort();
}
