import { z } from "zod";
import { getStepHandler, listRegisteredStepKinds } from "../steps/registry.js";
import { BindingConditionSchema, RequiresSchema } from "../bindings.js";

// BankaiPlanV1: the single unified plan shape. A plan is a name plus a
// sequence of steps. There is NO kind discriminator on the plan itself.
// What was previously "scoped" vs "long-running" is now expressed by
// what steps the plan contains. A plan with `setup` (no registerAs) +
// shell + assert is what test plans look like. A plan with `setup`
// (registerAs) + wait is what dev-loop plans look like. The CLI runs
// either via the same `bankai run <plan>` verb.
//
// Step kinds are a CLOSED registry. Adding a new kind requires a new
// file under src/steps/ and an import in src/steps/index.ts. The plan
// validator looks up each step's kind in the registry; an unknown kind
// fails preflight before any step runs.
//
// Step-specific schemas live with each step file. This module's job is
// to validate the OUTER shape (id uniqueness, kind exists, common
// fields) and dispatch to the per-kind schema for inner validation.
//
// Invariants the next editor must preserve:
//   1. Every step has a unique id within a plan. Step output is
//      addressable by id (e.g. assert step references a shell step by
//      stepId). Duplicate ids fail preflight.
//   2. Plan validation is a single zod parse. Errors collect across
//      all steps so the user sees every typo in one shot, not one at
//      a time.
//   3. The step kind discriminator is z.string() at the outer layer,
//      with superRefine deferring to the per-kind schema. We do NOT
//      use z.discriminatedUnion because new step kinds register at
//      module load and the union would have to be rebuilt; the
//      defer-to-registry approach lets the schema and registry stay
//      in sync without a recompile.

export const StepCommonSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  /** When true, a failure of this step does NOT stop the plan. The step result still records ok=false. Default false. */
  continueOnFail: z.boolean().default(false),
}).strict();

export type StepCommon = z.infer<typeof StepCommonSchema>;

// The outer step ref is a passthrough object that owns id+kind+
// continueOnFail. The kind-specific fields are validated by the
// matching step handler's schema during superRefine.
export const StepRefSchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1),
    continueOnFail: z.boolean().optional(),
    alwaysRun: z.boolean().optional(),
    runIf: BindingConditionSchema.optional(),
    skipIf: BindingConditionSchema.optional(),
  })
  .passthrough()
  .superRefine((step, ctx) => {
    let handler;
    try {
      handler = getStepHandler(step.kind);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `unknown step kind "${step.kind}". Registered kinds: ${listRegisteredStepKinds().join(", ")}`,
        path: ["kind"],
      });
      return;
    }
    const inner = handler.schema.safeParse(step);
    if (!inner.success) {
      for (const issue of inner.error.issues) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: issue.message,
          path: issue.path,
        });
      }
    }
  });

export type StepRef = z.infer<typeof StepRefSchema>;

export const BankaiPlanV1Schema = z
  .object({
    schemaVersion: z.literal("1"),
    name: z.string().min(1),
    description: z.string().optional(),
    requires: RequiresSchema.optional(),
    steps: z.array(StepRefSchema).min(1),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < plan.steps.length; i++) {
      const id = plan.steps[i].id;
      if (seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate step id "${id}"`,
          path: ["steps", i, "id"],
        });
      }
      seen.add(id);
    }
  });

export type BankaiPlanV1 = z.infer<typeof BankaiPlanV1Schema>;

// Readiness probe ref shape. Wait steps reference probes by kind+id+
// arbitrary-config. Each probe plugin owns its own configSchema; the
// wait step validates each ref against the matching probe's schema at
// preflight, mirroring the pattern used for tool and assert steps.
export const ReadinessProbeRefSchema = z
  .object({
    kind: z.string().min(1),
    id: z.string().min(1),
  })
  .passthrough();

export type ReadinessProbeRef = z.infer<typeof ReadinessProbeRefSchema>;
