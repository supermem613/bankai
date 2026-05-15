import { z } from "zod";
import { registerStep, type StepContext, type StepRunResult } from "./registry.js";
import { ReadinessProbeRefSchema } from "../plan/schema.js";
import { evaluateReadiness } from "../readiness/evaluate.js";
import type { ProcessHandle } from "../registry/types.js";
import { isProcessAlive } from "../process-tree.js";

// wait step kind: poll a set of readiness probes until all return ok
// or timeout fires. The handle to test against comes from either a
// prior setup step (`fromStepId`) or the persistent registry
// (`fromRegistry`).
//
// Invariants the next editor must preserve:
//   1. Probes are evaluated atomically per cycle. evaluateReadiness
//      runs every ref and returns one observation per ref. The wait
//      step polls it at pollIntervalMs cadence.
//   2. Re-check pid liveness on every cycle. If the pid dies during
//      wait the step fails immediately rather than polling forever.
//   3. Empty probes array is a programming error and fails preflight.
//      Otherwise wait would never complete.
//   4. Each cycle's observations are emitted to the JSONL log so a
//      reader can see the full convergence path.

export const WaitStepV1Schema = z
  .object({
    kind: z.literal("wait"),
    id: z.string().min(1),
    /** Resolve handle from a prior setup step's id. */
    fromStepId: z.string().min(1).optional(),
    /** Resolve handle from a registered name. */
    fromRegistry: z.string().min(1).optional(),
    for: z.array(ReadinessProbeRefSchema).min(1),
    timeoutMs: z.number().int().positive().default(15_000),
    pollIntervalMs: z.number().int().positive().default(250),
    continueOnFail: z.boolean().optional(),
  })
  .superRefine((spec, ctx) => {
    if (!spec.fromStepId && !spec.fromRegistry) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "wait step needs fromStepId or fromRegistry",
        path: ["fromStepId"],
      });
    }
    if (spec.fromStepId && spec.fromRegistry) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "wait step accepts fromStepId OR fromRegistry, not both",
        path: ["fromStepId"],
      });
    }
  });

export type WaitStepV1 = z.infer<typeof WaitStepV1Schema>;

async function resolveHandle(spec: WaitStepV1, ctx: StepContext): Promise<{ handle?: ProcessHandle; error?: string }> {
  if (spec.fromStepId) {
    const handle = ctx.handles.get(spec.fromStepId);
    if (!handle) {
      return { error: `no handle from step "${spec.fromStepId}". The step must be a setup step that ran before this wait.` };
    }
    return { handle };
  }
  if (spec.fromRegistry) {
    const entry = await ctx.registry.getEntry(spec.fromRegistry);
    if (!entry) {
      return { error: `no registered handle named "${spec.fromRegistry}"` };
    }
    return { handle: entry };
  }
  return { error: "wait step had neither fromStepId nor fromRegistry" };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function runWaitStep(spec: WaitStepV1, ctx: StepContext): Promise<StepRunResult> {
  const r = await resolveHandle(spec, ctx);
  if (!r.handle) {
    return {
      ok: false,
      error: r.error,
      wait: { attempts: 0, observations: [], allReady: false },
    };
  }
  const handle = r.handle;
  ctx.logger.emit("step.wait.begin", {
    stepId: spec.id,
    pid: handle.pid,
    timeoutMs: spec.timeoutMs,
    pollIntervalMs: spec.pollIntervalMs,
    probeCount: spec.for.length,
  });

  const deadline = ctx.env.clock.now() + spec.timeoutMs;
  const ac = new AbortController();
  const onParentAbort = (): void => ac.abort(ctx.signal.reason);
  if (ctx.signal.aborted) {
    onParentAbort();
  } else {
    ctx.signal.addEventListener("abort", onParentAbort, { once: true });
  }

  let attempts = 0;
  let lastObservations: Awaited<ReturnType<typeof evaluateReadiness>>["observations"] = [];
  try {
    while (ctx.env.clock.now() <= deadline && !ctx.signal.aborted) {
      attempts += 1;
      if (!isProcessAlive(handle.pid)) {
        ctx.logger.emit("step.wait.dead", { stepId: spec.id, pid: handle.pid });
        return {
          ok: false,
          error: `pid ${handle.pid} died during wait`,
          wait: { attempts, observations: lastObservations, allReady: false },
        };
      }
      const result = await evaluateReadiness({
        env: ctx.env,
        handle,
        signal: ac.signal,
        refs: spec.for,
      });
      lastObservations = result.observations;
      ctx.logger.emit("step.wait.poll", {
        stepId: spec.id,
        attempt: attempts,
        allReady: result.allReady,
        observations: result.observations,
      });
      if (result.allReady) {
        ctx.logger.emit("step.wait.ready", { stepId: spec.id, attempts });
        return { ok: true, wait: { attempts, observations: result.observations, allReady: true } };
      }
      const remaining = deadline - ctx.env.clock.now();
      if (remaining <= 0) {
        break;
      }
      await delay(Math.min(spec.pollIntervalMs, remaining));
    }
    ctx.logger.emit("step.wait.timeout", { stepId: spec.id, attempts });
    return {
      ok: false,
      error: `wait timed out after ${spec.timeoutMs}ms with ${attempts} attempt(s)`,
      wait: { attempts, observations: lastObservations, allReady: false },
    };
  } finally {
    ctx.signal.removeEventListener("abort", onParentAbort);
  }
}

registerStep({
  kind: "wait",
  schema: WaitStepV1Schema,
  run: runWaitStep,
});
