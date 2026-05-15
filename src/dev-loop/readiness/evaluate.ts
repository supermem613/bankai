import type { Env } from "../../env-runtime/env.js";
import type { DevLoopStateEntry, ReadinessObservation } from "../envelope.js";
import type { ReadinessProbeRef } from "../schema.js";
import { getReadinessProbe } from "./registry.js";

// One-shot evaluation of a readiness probe set. Validates each ref
// against the matching probe's configSchema, evaluates it, returns one
// observation per ref. The orchestrator's wait-ready loop calls this
// repeatedly at a polling cadence until allReady or timeout.
//
// Validation failures are NOT thrown. They become an observation with
// ok=false and a detail explaining the schema mismatch. Throwing here
// would abort the whole wait on the first malformed ref, which is
// worse than reporting it and continuing to evaluate the others. The
// orchestrator decides what to do with a partial-failure result.

export interface EvaluateReadinessContext {
  env: Env;
  state: DevLoopStateEntry;
  signal: AbortSignal;
  refs: readonly ReadinessProbeRef[];
}

export interface EvaluateReadinessResult {
  allReady: boolean;
  observations: ReadinessObservation[];
}

export async function evaluateReadiness(ctx: EvaluateReadinessContext): Promise<EvaluateReadinessResult> {
  const observations: ReadinessObservation[] = [];
  for (const ref of ctx.refs) {
    const checkedAt = ctx.env.clock.isoNow();
    const probe = getReadinessProbe(ref.kind);
    if (!probe) {
      observations.push({
        id: ref.id,
        kind: ref.kind,
        ok: false,
        detail: `unknown readiness probe kind: ${ref.kind}`,
        checkedAt,
      });
      continue;
    }
    const parsed = probe.configSchema.safeParse(ref);
    if (!parsed.success) {
      observations.push({
        id: ref.id,
        kind: ref.kind,
        ok: false,
        detail: `config invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        checkedAt,
      });
      continue;
    }
    let outcome;
    try {
      outcome = await probe.evaluate({ env: ctx.env, state: ctx.state, signal: ctx.signal }, parsed.data);
    } catch (err) {
      observations.push({
        id: ref.id,
        kind: ref.kind,
        ok: false,
        detail: `probe threw: ${(err as Error).message}`,
        checkedAt,
      });
      continue;
    }
    observations.push({
      id: ref.id,
      kind: ref.kind,
      ok: outcome.ok,
      detail: outcome.detail,
      checkedAt,
    });
  }
  const allReady = observations.length > 0 && observations.every((o) => o.ok);
  return { allReady, observations };
}
