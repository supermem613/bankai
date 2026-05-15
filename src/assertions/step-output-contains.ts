import { z } from "zod";
import { registerAssertion, type AssertionContext } from "./_registry.js";
import type { BankaiAssertionResult } from "../schema/envelope.js";

// step-output-contains: assert that a prior step's stdout or stderr contains
// a given substring. Invariants the next editor must preserve:
//   1. The referenced step must have run. If stepId does not match any prior
//      step, the assertion fails with a clear "no such step" detail.
//   2. The match is plain substring. Regex matching belongs in a separate
//      kind so the spec stays unambiguous about escaping rules.

export const StepOutputContainsAssertionV1Schema = z.object({
  kind: z.literal("step-output-contains"),
  id: z.string().min(1),
  stepId: z.string().min(1),
  stream: z.enum(["stdout", "stderr"]).default("stdout"),
  text: z.string().min(1),
});

export type StepOutputContainsAssertionV1 = z.infer<typeof StepOutputContainsAssertionV1Schema>;

async function evaluateStepOutputContains(
  spec: StepOutputContainsAssertionV1,
  ctx: AssertionContext,
): Promise<Omit<BankaiAssertionResult, "id" | "kind">> {
  const step = ctx.stepResults.find((s) => s.id === spec.stepId);
  if (!step) {
    return { ok: false, detail: `no step with id "${spec.stepId}" was run` };
  }
  const haystack = spec.stream === "stdout" ? step.stdout ?? "" : step.stderr ?? "";
  if (haystack.includes(spec.text)) {
    return { ok: true, detail: `${spec.stream} of step "${spec.stepId}" contains "${spec.text}"` };
  }
  return {
    ok: false,
    detail: `${spec.stream} of step "${spec.stepId}" does NOT contain "${spec.text}"`,
  };
}

registerAssertion({
  kind: "step-output-contains",
  schema: StepOutputContainsAssertionV1Schema,
  evaluate: evaluateStepOutputContains,
});
