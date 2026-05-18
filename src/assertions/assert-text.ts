import { readFile } from "node:fs/promises";
import { z } from "zod";
import { BindingPathRefSchema, interpolateBindings, resolveBindingPath } from "../bindings.js";
import { registerAssertion, type AssertionContext, type AssertionOutcome } from "./registry.js";

export const AssertTextAssertionV1Schema = z.object({
  kind: z.literal("assert-text"),
  id: z.string().min(1),
  file: BindingPathRefSchema,
  contains: z.string().optional(),
  notContains: z.string().optional(),
  regex: z.string().optional(),
  flags: z.string().regex(/^[dgimsuvy]*$/).optional(),
}).strict().superRefine((spec, ctx) => {
  const checks = [spec.contains, spec.notContains, spec.regex].filter((value) => value !== undefined).length;
  if (checks === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "assert-text needs contains, notContains, or regex" });
  }
  if (spec.regex) {
    try {
      new RegExp(spec.regex, spec.flags);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : String(err),
        path: ["regex"],
      });
    }
  }
});

export type AssertTextAssertionV1 = z.infer<typeof AssertTextAssertionV1Schema>;

async function evaluateAssertText(spec: AssertTextAssertionV1, ctx: AssertionContext): Promise<AssertionOutcome> {
  const file = resolveBindingPath(spec.file, { workDir: ctx.workDir, bindings: ctx.bindings });
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    return { ok: false, detail: `could not read "${file}": ${err instanceof Error ? err.message : String(err)}` };
  }
  const contains = spec.contains === undefined ? undefined : interpolateBindings(spec.contains, { bindings: ctx.bindings });
  if (contains !== undefined && !text.includes(contains)) {
    return { ok: false, detail: `file "${file}" does NOT contain "${contains}"` };
  }
  const notContains = spec.notContains === undefined ? undefined : interpolateBindings(spec.notContains, { bindings: ctx.bindings });
  if (notContains !== undefined && text.includes(notContains)) {
    return { ok: false, detail: `file "${file}" contains forbidden text "${notContains}"` };
  }
  const regex = spec.regex === undefined ? undefined : interpolateBindings(spec.regex, { bindings: ctx.bindings });
  if (regex !== undefined && !new RegExp(regex, spec.flags).test(text)) {
    return { ok: false, detail: `file "${file}" does NOT match /${regex}/${spec.flags ?? ""}` };
  }
  return { ok: true, detail: `file "${file}" passed text assertions` };
}

registerAssertion({
  kind: "assert-text",
  schema: AssertTextAssertionV1Schema,
  evaluate: evaluateAssertText,
});
