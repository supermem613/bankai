import { readFile } from "node:fs/promises";
import { z } from "zod";
import { BindingPathRefSchema, interpolateBindings, resolveBindingPath } from "../bindings.js";
import { registerAssertion, type AssertionContext, type AssertionOutcome } from "./registry.js";

const PathSegmentSchema = z.union([z.string(), z.number().int().nonnegative()]);
const JsonScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const AssertJsonAssertionV1Schema = z.object({
  kind: z.literal("assert-json"),
  id: z.string().min(1),
  file: BindingPathRefSchema,
  path: z.array(PathSegmentSchema).default([]),
  exists: z.boolean().optional(),
  equals: JsonScalarSchema.optional(),
  contains: z.string().optional(),
  notContains: z.string().optional(),
  regex: z.string().optional(),
  flags: z.string().regex(/^[dgimsuvy]*$/).optional(),
  arrayContainsObject: z.record(z.string(), JsonScalarSchema).optional(),
}).strict().superRefine((spec, ctx) => {
  const checks = [
    spec.exists,
    spec.equals,
    spec.contains,
    spec.notContains,
    spec.regex,
    spec.arrayContainsObject,
  ].filter((value) => value !== undefined).length;
  if (checks === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "assert-json needs at least one assertion" });
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

export type AssertJsonAssertionV1 = z.infer<typeof AssertJsonAssertionV1Schema>;

function readPath(root: unknown, path: Array<string | number>): { found: boolean; value: unknown } {
  let current = root;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment >= current.length) {
        return { found: false, value: undefined };
      }
      current = current[segment];
      continue;
    }
    if (typeof current !== "object" || current === null || !(segment in current)) {
      return { found: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function objectMatches(value: unknown, expected: Record<string, string | number | boolean | null>): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return Object.entries(expected).every(([key, expectedValue]) => record[key] === expectedValue);
}

function interpolateScalar(value: string | number | boolean | null, ctx: AssertionContext): string | number | boolean | null {
  return typeof value === "string" ? interpolateBindings(value, { bindings: ctx.bindings }) : value;
}

async function evaluateAssertJson(spec: AssertJsonAssertionV1, ctx: AssertionContext): Promise<AssertionOutcome> {
  const file = resolveBindingPath(spec.file, { workDir: ctx.workDir, bindings: ctx.bindings });
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    return { ok: false, detail: `could not parse JSON "${file}": ${err instanceof Error ? err.message : String(err)}` };
  }
  const selected = readPath(parsed, spec.path);
  if (spec.exists !== undefined && selected.found !== spec.exists) {
    return { ok: false, detail: `JSON path ${spec.path.join(".")} exists=${selected.found}, expected ${spec.exists}` };
  }
  if (!selected.found) {
    return { ok: false, detail: `JSON path ${spec.path.join(".")} was not found` };
  }
  const expectedEquals = spec.equals === undefined ? undefined : interpolateScalar(spec.equals, ctx);
  if (expectedEquals !== undefined && selected.value !== expectedEquals) {
    return { ok: false, detail: `JSON path ${spec.path.join(".")} did not equal ${JSON.stringify(expectedEquals)}` };
  }
  const text = asText(selected.value);
  const contains = spec.contains === undefined ? undefined : interpolateBindings(spec.contains, { bindings: ctx.bindings });
  if (contains !== undefined && !text.includes(contains)) {
    return { ok: false, detail: `JSON path ${spec.path.join(".")} does NOT contain "${contains}"` };
  }
  const notContains = spec.notContains === undefined ? undefined : interpolateBindings(spec.notContains, { bindings: ctx.bindings });
  if (notContains !== undefined && text.includes(notContains)) {
    return { ok: false, detail: `JSON path ${spec.path.join(".")} contains forbidden text "${notContains}"` };
  }
  const regex = spec.regex === undefined ? undefined : interpolateBindings(spec.regex, { bindings: ctx.bindings });
  if (regex !== undefined && !new RegExp(regex, spec.flags).test(text)) {
    return { ok: false, detail: `JSON path ${spec.path.join(".")} does NOT match /${regex}/${spec.flags ?? ""}` };
  }
  if (spec.arrayContainsObject !== undefined) {
    const expectedObject = Object.fromEntries(
      Object.entries(spec.arrayContainsObject).map(([key, value]) => [key, interpolateScalar(value, ctx)]),
    );
    if (!Array.isArray(selected.value) || !selected.value.some((item) => objectMatches(item, expectedObject))) {
      return { ok: false, detail: `JSON path ${spec.path.join(".")} does not contain the expected object` };
    }
  }
  return { ok: true, detail: `JSON file "${file}" passed assertions at ${spec.path.join(".") || "<root>"}` };
}

registerAssertion({
  kind: "assert-json",
  schema: AssertJsonAssertionV1Schema,
  evaluate: evaluateAssertJson,
});
