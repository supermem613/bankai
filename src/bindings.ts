import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { Env } from "./env-runtime/env.js";

export const BindingValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export type BindingValue = z.infer<typeof BindingValueSchema>;

export const BindingTypeSchema = z.enum(["string", "number", "boolean", "path", "url"]);
export type BindingType = z.infer<typeof BindingTypeSchema>;

export const BindingRequirementSchema = z.object({
  type: BindingTypeSchema,
  required: z.boolean().default(true),
  description: z.string().optional(),
  default: BindingValueSchema.optional(),
}).strict();

export type BindingRequirement = z.infer<typeof BindingRequirementSchema>;

export const RequiresSchema = z.object({
  bindings: z.record(z.string().min(1), BindingRequirementSchema).default({}),
}).strict().default({ bindings: {} });

export type Requires = z.infer<typeof RequiresSchema>;

export const BindingEntrySchema = z.object({
  key: z.string().min(1),
  value: BindingValueSchema,
}).strict();

export const BindingsArraySchema = z.array(BindingEntrySchema);
export type BindingEntry = z.infer<typeof BindingEntrySchema>;
export type ResolvedBindings = Readonly<Record<string, BindingValue>>;

export const BindingPathRefSchema = z.union([
  z.string(),
  z.object({
    binding: z.string().min(1),
    path: z.string().optional(),
  }).strict(),
]);

export type BindingPathRef = z.infer<typeof BindingPathRefSchema>;

export interface ResolveBindingsResultOk {
  ok: true;
  bindings: ResolvedBindings;
}

export interface ResolveBindingsResultErr {
  ok: false;
  errors: string[];
}

export type ResolveBindingsResult = ResolveBindingsResultOk | ResolveBindingsResultErr;

export function parseBindingsJson(json: string): BindingEntry[] {
  const parsed = JSON.parse(json) as unknown;
  return BindingsArraySchema.parse(parsed);
}

export async function readBindingsFile(opts: { env: Env; path: string }): Promise<BindingEntry[]> {
  const filePath = isAbsolute(opts.path) ? opts.path : resolve(opts.env.cwd, opts.path);
  const raw = await readFile(filePath, "utf8");
  return parseBindingsJson(raw);
}

export function resolveBindings(requirements: Requires | undefined, entries: BindingEntry[]): ResolveBindingsResult {
  const requiredBindings = requirements?.bindings ?? {};
  const values: Record<string, BindingValue> = {};
  const errors: string[] = [];
  for (const entry of entries) {
    if (Object.prototype.hasOwnProperty.call(values, entry.key)) {
      errors.push(`duplicate binding "${entry.key}"`);
      continue;
    }
    values[entry.key] = entry.value;
  }
  for (const [key, req] of Object.entries(requiredBindings)) {
    const hasValue = Object.prototype.hasOwnProperty.call(values, key);
    if (!hasValue && req.default !== undefined) {
      values[key] = req.default;
    }
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      if (req.required !== false) {
        errors.push(`missing required binding "${key}"`);
      }
      continue;
    }
    const value = values[key];
    const typeError = validateBindingType(key, value, req.type);
    if (typeError) {
      errors.push(typeError);
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, bindings: Object.freeze(values) };
}

function validateBindingType(key: string, value: BindingValue, type: BindingType): string | undefined {
  if (type === "path" || type === "url" || type === "string") {
    if (typeof value !== "string") {
      return `binding "${key}" must be a ${type} string`;
    }
    if (value.length === 0) {
      return `binding "${key}" must not be empty`;
    }
    if (type === "url") {
      try {
        new URL(value);
      } catch {
        return `binding "${key}" must be a valid URL`;
      }
    }
    return undefined;
  }
  if (type === "number" && typeof value !== "number") {
    return `binding "${key}" must be a number`;
  }
  if (type === "boolean" && typeof value !== "boolean") {
    return `binding "${key}" must be a boolean`;
  }
  return undefined;
}

export function resolveBindingPath(ref: BindingPathRef | undefined, opts: { workDir: string; bindings: ResolvedBindings }): string {
  if (!ref) {
    return opts.workDir;
  }
  if (typeof ref === "string") {
    return isAbsolute(ref) ? ref : resolve(opts.workDir, ref);
  }
  const value = opts.bindings[ref.binding];
  if (typeof value !== "string") {
    throw new Error(`binding "${ref.binding}" must be a path string`);
  }
  const base = isAbsolute(value) ? value : resolve(opts.workDir, value);
  return ref.path ? resolve(base, ref.path) : base;
}

export function bindingsSchemaDocument(): unknown {
  return {
    description: "Bindings are supplied at run time as a JSON array. Plans declare required binding keys in requires.bindings.",
    arrayShape: [
      { key: "workspace", value: "C:\\Users\\alice\\repos\\service" },
      { key: "devPort", value: 3000 },
      { key: "targetUrl", value: "https://example.test/app" },
    ],
    requirementShape: {
      schemaVersion: "1",
      name: "example",
      requires: {
        bindings: {
          workspace: { type: "path", required: true, description: "Repo used as cwd for workflow commands" },
          devPort: { type: "number", required: false, default: 3000 },
          targetUrl: { type: "url", required: true },
        },
      },
      steps: [],
    },
    cli: {
      file: "bankai run plan.json --bindings-file bindings.local.json --json",
      inline: "bankai run plan.json --bindings-json '[{\"key\":\"workspace\",\"value\":\"C:\\\\Users\\\\alice\\\\repos\\\\service\"}]' --json",
    },
  };
}
