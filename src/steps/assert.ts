import { z } from "zod";
import { registerStep, type StepContext, type StepRunResult } from "./registry.js";
import { getAssertionHandler } from "../assertions/registry.js";
import { BindingConditionSchema } from "../bindings.js";

// assert step kind: closed step kind that dispatches to the closed
// assertion registry. An assert step references an assertion by kind
// and supplies its config inline.
//
// Why assertions are also a step kind in the unified model: the old
// design had a separate assertions array on the plan that ran AFTER
// all steps. In the unified model a plan is just a sequence of steps;
// assertions become first-class steps that can run anywhere. Their
// failure stops the plan unless `continueOnFail: true` (typical for
// test plans where you want every assertion to report).
//
// Invariants the next editor must preserve:
//   1. The outer schema is closed. The inner assertion config is
//      validated against the matching assertion handler's schema via
//      superRefine at preflight.
//   2. assert.stepRef pulls a prior step's result by id. The
//      assertion handler reads from ctx.priorResults to evaluate
//      against shell stdout, exit code, etc.

export const AssertStepV1Schema = z
  .object({
    kind: z.literal("assert"),
    id: z.string().min(1),
    assertion: z.string().min(1),
    config: z.unknown().optional(),
    continueOnFail: z.boolean().optional(),
    alwaysRun: z.boolean().optional(),
    runIf: BindingConditionSchema.optional(),
    skipIf: BindingConditionSchema.optional(),
  })
  .strict()
  .superRefine((spec, ctx) => {
    let handler;
    try {
      handler = getAssertionHandler(spec.assertion);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `unknown assertion kind: ${spec.assertion}`,
        path: ["assertion"],
      });
      return;
    }
    const inner = handler.schema.safeParse({
      kind: spec.assertion,
      id: spec.id,
      ...(typeof spec.config === "object" && spec.config !== null ? spec.config : {}),
    });
    if (!inner.success) {
      for (const issue of inner.error.issues) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: issue.message,
          path: ["config", ...issue.path.filter((p) => p !== "kind" && p !== "id")],
        });
      }
    }
  });

export type AssertStepV1 = z.infer<typeof AssertStepV1Schema>;

async function runAssertStep(spec: AssertStepV1, ctx: StepContext): Promise<StepRunResult> {
  const handler = getAssertionHandler(spec.assertion);
  const config = handler.schema.parse({
    kind: spec.assertion,
    id: spec.id,
    ...(typeof spec.config === "object" && spec.config !== null ? spec.config : {}),
  });
  ctx.logger.emit("step.assert.start", { stepId: spec.id, assertion: spec.assertion });
  const outcome = await handler.evaluate(config, {
    env: ctx.env,
    workDir: ctx.workDir,
    bindings: ctx.bindings,
    priorResults: ctx.priorResults,
  });
  ctx.logger.emit("step.assert.end", { stepId: spec.id, ok: outcome.ok, detail: outcome.detail });
  return {
    ok: outcome.ok,
    error: outcome.ok ? undefined : outcome.detail,
    assert: { detail: outcome.detail },
  };
}

registerStep({
  kind: "assert",
  schema: AssertStepV1Schema,
  run: runAssertStep,
});
