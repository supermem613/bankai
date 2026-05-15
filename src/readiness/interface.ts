import { z } from "zod";
import type { Env } from "../env-runtime/env.js";
import type { ProcessHandle } from "../registry/types.js";

// Readiness probe contract. Probes are an OPEN registry: any plugin can
// add a kind. They are referenced from the `wait` step's `for` array,
// each entry carrying kind + id plus arbitrary plugin-specific fields.
// Each probe plugin owns the config schema for its own fields. The wait
// step validates each ref against the matching plugin's configSchema at
// preflight, mirroring how the tool plugin layer validates tool steps.
//
// Invariants the next editor must preserve:
//   1. evaluate is idempotent and side-effect-free. The wait step polls
//      probes repeatedly until all return ok or timeout fires. A probe
//      that mutates external state would corrupt the loop.
//   2. detail is human-readable and suitable for inclusion in the
//      BankaiEnvelope observations array. It must NOT include secrets
//      or full file contents.
//   3. Probes get a ProcessHandle in context. They MUST treat it as
//      read-only. The handle is owned by either the LifecycleScope (for
//      a scoped setup step) or the registry (for a persistent setup
//      step). Probes never mutate it.

export interface ReadinessContext {
  env: Env;
  handle: ProcessHandle;
  signal: AbortSignal;
}

export interface ReadinessOutcome {
  ok: boolean;
  detail: string;
}

export interface ReadinessProbe<S extends z.ZodTypeAny = z.ZodTypeAny> {
  kind: string;
  configSchema: S;
  evaluate(ctx: ReadinessContext, config: z.output<S>): Promise<ReadinessOutcome>;
}
