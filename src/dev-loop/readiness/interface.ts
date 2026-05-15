import { z } from "zod";
import type { Env } from "../../env-runtime/env.js";
import type { DevLoopStateEntry } from "../envelope.js";

// Readiness probe contract. Probes are an OPEN registry: any plugin can
// add a kind. The outer ref shape lives on DevLoopPlanV1.readiness and
// carries kind + id plus arbitrary fields. Each probe plugin owns the
// config schema for its own fields. The orchestrator validates each ref
// against the matching plugin's configSchema at preflight, exactly like
// the tool plugin layer does for tool steps.
//
// Invariants the next editor must preserve:
//   1. evaluate is idempotent and side-effect-free. The orchestrator
//      polls probes repeatedly until all return ok or timeout fires.
//      A probe that mutates external state would corrupt the loop.
//   2. detail is human-readable and suitable for inclusion in the
//      BankaiDevLoopEnvelope observations[]. It must NOT include
//      secrets or full file contents.
//   3. Probes get DevLoopStateEntry in context. They MUST treat it as
//      read-only. The state file is the source of truth and is owned
//      by the StateStore.

export interface ReadinessContext {
  env: Env;
  state: DevLoopStateEntry;
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
