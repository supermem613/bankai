import type { ReadinessProbe } from "./interface.js";

// Open registry of readiness probes. Same shape as the environment and
// tool plugin registries. INVARIANT: registration is one-shot per kind
// inside a single process. Re-registration is a programming error and
// throws so test isolation problems surface loudly instead of silently
// swapping plugins between tests.

const probes = new Map<string, ReadinessProbe>();

export function registerReadinessProbe(probe: ReadinessProbe): void {
  if (probes.has(probe.kind)) {
    throw new Error(`readiness probe kind already registered: ${probe.kind}`);
  }
  probes.set(probe.kind, probe);
}

export function getReadinessProbe(kind: string): ReadinessProbe | undefined {
  return probes.get(kind);
}

export function listReadinessProbes(): string[] {
  return [...probes.keys()].sort();
}

// Test-only escape hatch. Production code MUST NOT call this. Tests use
// it to register a stub probe and then unregister it so no spillover
// reaches the next test file.
export function unregisterReadinessProbeForTesting(kind: string): void {
  probes.delete(kind);
}
