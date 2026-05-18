import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { BindingPathRefSchema, BindingValueRefSchema, interpolateBindings, resolveBindingPath, resolveBindingValueRef } from "../bindings.js";
import { registerStep, type StepContext, type StepRunResult } from "./registry.js";

const ContentSchema = z.union([z.string(), BindingValueRefSchema]);

export const WriteFileStepV1Schema = z.object({
  kind: z.literal("write-file"),
  id: z.string().min(1),
  file: BindingPathRefSchema,
  content: ContentSchema,
  encoding: z.literal("utf8").default("utf8"),
  maxBytes: z.number().int().positive().default(1_048_576),
  continueOnFail: z.boolean().optional(),
  alwaysRun: z.boolean().optional(),
}).strict();

export type WriteFileStepV1 = z.infer<typeof WriteFileStepV1Schema>;

async function runWriteFile(spec: WriteFileStepV1, ctx: StepContext): Promise<StepRunResult> {
  const file = resolveBindingPath(spec.file, { workDir: ctx.workDir, bindings: ctx.bindings });
  const content = typeof spec.content === "object"
    ? resolveBindingValueRef(spec.content, { workDir: ctx.workDir, bindings: ctx.bindings })
    : interpolateBindings(spec.content, { bindings: ctx.bindings });
  const bytes = Buffer.byteLength(content, spec.encoding);
  if (bytes > spec.maxBytes) {
    return {
      ok: false,
      error: `write-file content is ${bytes} bytes, exceeding maxBytes ${spec.maxBytes}`,
      writeFile: { file, bytes },
    };
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, spec.encoding);
  ctx.logger.emit("step.write-file.wrote", { stepId: spec.id, file, bytes });
  return { ok: true, writeFile: { file, bytes } };
}

registerStep({
  kind: "write-file",
  schema: WriteFileStepV1Schema,
  run: runWriteFile,
});
