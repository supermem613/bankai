import { z } from "zod";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath, isAbsolute as isAbsolutePath } from "node:path";
import { registerAssertion, type AssertionContext } from "./registry.js";
import type { BankaiAssertionResult } from "../schema/envelope.js";

// assert-text-contains: assert that a file on disk contains a given substring.
// Distinct from step-output-contains which reads a prior step's stdout or
// stderr. This kind exists because kash-prompt and other step kinds write
// their response to a separate output file rather than to stdout, and tests
// also need to assert on artifacts produced under the scenario workDir.
//
// Invariants the next editor must preserve:
//   1. file is resolved against ctx.workDir when relative. Absolute paths are
//      honored as-is. Same contract the shell step uses for cwd.
//   2. The match is plain substring. Regex matching belongs in a separate
//      kind so the spec stays unambiguous about escaping rules.
//   3. ENOENT and unreadable files surface as ok=false with a clear detail.
//      They never throw out of the assertion handler.
//   4. detail must be safe to log. Do not include file contents.

export const AssertTextContainsAssertionV1Schema = z.object({
  kind: z.literal("assert-text-contains"),
  id: z.string().min(1),
  file: z.string().min(1),
  text: z.string().min(1),
});

export type AssertTextContainsAssertionV1 = z.infer<typeof AssertTextContainsAssertionV1Schema>;

async function evaluateAssertTextContains(
  spec: AssertTextContainsAssertionV1,
  ctx: AssertionContext,
): Promise<Omit<BankaiAssertionResult, "id" | "kind">> {
  const absolute = isAbsolutePath(spec.file) ? spec.file : resolvePath(ctx.workDir, spec.file);
  let contents: string;
  try {
    contents = await readFile(absolute, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `could not read "${spec.file}": ${reason}` };
  }
  if (contents.includes(spec.text)) {
    return { ok: true, detail: `file "${spec.file}" contains "${spec.text}"` };
  }
  return { ok: false, detail: `file "${spec.file}" does NOT contain "${spec.text}"` };
}

registerAssertion({
  kind: "assert-text-contains",
  schema: AssertTextContainsAssertionV1Schema,
  evaluate: evaluateAssertTextContains,
});
