import type { ProcessHandle } from "../registry/types.js";

// HandleStore: in-process map of step id to ProcessHandle for setup
// steps that did NOT use registerAs. The store lives only for the
// duration of one runPlan call; LifecycleScope tears down the
// underlying resources at plan end. Subsequent steps (wait, stop, etc.)
// resolve `fromStepId: "X"` references through this store.
//
// INVARIANT: register is one-shot per step id. A second register for
// the same id is a programming error and throws so duplicate handle
// creation surfaces loudly.

export interface HandleStore {
  register(stepId: string, handle: ProcessHandle): void;
  get(stepId: string): ProcessHandle | undefined;
  list(): readonly { stepId: string; handle: ProcessHandle }[];
}

export function createHandleStore(): HandleStore {
  const map = new Map<string, ProcessHandle>();
  return {
    register(stepId, handle): void {
      if (map.has(stepId)) {
        throw new Error(`handle already registered for step "${stepId}"`);
      }
      map.set(stepId, handle);
    },
    get(stepId): ProcessHandle | undefined {
      return map.get(stepId);
    },
    list(): readonly { stepId: string; handle: ProcessHandle }[] {
      return [...map.entries()].map(([stepId, handle]) => ({ stepId, handle }));
    },
  };
}
