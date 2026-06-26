import { z } from "zod";
import { isAbsolute, resolve } from "node:path";
import { registerStep, type StepContext, type StepRunResult } from "./registry.js";
import { loadPlan } from "../plan/load.js";
import { runPlan } from "../orchestrator/run.js";
import { BindingConditionSchema } from "../bindings.js";

// run-plan step kind: execute another plan inline as a sub-step. Pure
// composition primitive. Lets a top-level plan invoke a smaller plan
// (e.g. "shutdown" plans) without duplicating its steps.
//
// Invariants the next editor must preserve:
//   1. The sub-plan path is resolved against ctx.workDir. Sub-plans
//      can sit alongside the parent plan, or in a sibling directory
//      via "../".
//   2. The sub-plan inherits the same logger so its events land in
//      the same JSONL file as the parent. Sub-plan events get a
//      `subPlan` field on each emitted record so a reader can group.
//   3. The sub-plan does NOT see the parent's HandleStore. Each
//      runPlan call gets its own. This keeps step ids isolated. To
//      pass a handle across plans, use the registry (registerAs).
//   4. Sub-plan failure becomes the run-plan step's failure. The
//      step result records a brief inner summary; the JSONL log has
//      the full sub-plan story.

export const RunPlanStepV1Schema = z.object({
  kind: z.literal("run-plan"),
  id: z.string().min(1),
  plan: z.string().min(1),
  continueOnFail: z.boolean().optional(),
  alwaysRun: z.boolean().optional(),
  runIf: BindingConditionSchema.optional(),
  skipIf: BindingConditionSchema.optional(),
}).strict();

export type RunPlanStepV1 = z.infer<typeof RunPlanStepV1Schema>;

async function runRunPlanStep(spec: RunPlanStepV1, ctx: StepContext): Promise<StepRunResult> {
  const subPlanPath = isAbsolute(spec.plan) ? spec.plan : resolve(ctx.workDir, spec.plan);
  ctx.logger.emit("step.run-plan.begin", { stepId: spec.id, subPlanPath });
  const loaded = await loadPlan({ env: ctx.env, planPath: subPlanPath });
  if (!loaded.ok) {
    ctx.logger.emit("step.run-plan.load-error", { stepId: spec.id, reason: loaded.reason });
    return {
      ok: false,
      error: loaded.reason,
      runPlan: { planName: "", planPath: loaded.planPath, inner: undefined },
    };
  }
  const inner = await runPlan({
    env: ctx.env,
    plan: loaded.plan,
    planPath: loaded.planPath,
    repoRoot: ctx.workDir,
    bindings: ctx.bindings,
    logger: ctx.logger,
    registry: ctx.registry,
    parentSignal: ctx.signal,
    sub: true,
  });
  ctx.logger.emit("step.run-plan.end", { stepId: spec.id, subPlanName: loaded.plan.name, ok: inner.ok });
  return {
    ok: inner.ok,
    error: inner.ok ? undefined : inner.failure?.reason,
    runPlan: {
      planName: loaded.plan.name,
      planPath: loaded.planPath,
      inner: { ok: inner.ok, steps: inner.steps.length, failure: inner.failure },
    },
  };
}

registerStep({
  kind: "run-plan",
  schema: RunPlanStepV1Schema,
  run: runRunPlanStep,
});
