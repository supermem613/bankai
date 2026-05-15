import { z } from "zod";
import { registerAssertion, type AssertionContext, type AssertionOutcome } from "./registry.js";

// step-output-contains: assert that a prior step's stdout or stderr
// contains a given substring. Invariants the next editor must preserve:
//   1. The referenced step must have run AND must be a shell or tool
//      step (the only kinds that produce stdout/stderr). Other kinds
//      surface a clear error.
//   2. The match is plain substring. Regex matching belongs in a
//      separate kind so the spec stays unambiguous about escaping.

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
): Promise<AssertionOutcome> {
  const step = ctx.priorResults.get(spec.stepId);
  if (!step) {
    return { ok: false, detail: `no prior step with id "${spec.stepId}" in this plan` };
  }
  let haystack: string | undefined;
  if (step.shell) {
    haystack = spec.stream === "stdout" ? step.shell.stdout : step.shell.stderr;
  } else if (step.tool) {
    haystack = spec.stream === "stdout" ? step.tool.stdout : step.tool.stderr;
  } else {
    return {
      ok: false,
      detail: `step "${spec.stepId}" is not a shell or tool step. step-output-contains needs stdout/stderr.`,
    };
  }
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
