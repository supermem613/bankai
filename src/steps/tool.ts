import { z } from "zod";
import { registerStep, type StepContext, type StepRunResult } from "./registry.js";
import { getTool } from "../tools/registry.js";
import { BindingPathRefSchema, resolveBindingPath } from "../bindings.js";

// tool step kind: closed step kind that dispatches to the OPEN registry
// of tool plugins under src/tools/. The outer schema is closed; only
// the tool plugin set grows. Inner config and invocation are validated
// against each plugin's schemas via superRefine at preflight.

export const ToolStepV1Schema = z
  .object({
    kind: z.literal("tool"),
    id: z.string().min(1),
    tool: z.string().min(1),
    config: z.unknown().optional(),
    invocation: z.unknown().optional(),
    cwd: BindingPathRefSchema.optional(),
    timeoutMs: z.number().int().positive().default(60_000),
    continueOnFail: z.boolean().optional(),
    alwaysRun: z.boolean().optional(),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const plugin = getTool(spec.tool);
    if (!plugin) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `unknown tool kind: ${spec.tool}`,
        path: ["tool"],
      });
      return;
    }
    const cfg = plugin.configSchema.safeParse(spec.config ?? {});
    if (!cfg.success) {
      for (const issue of cfg.error.issues) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: issue.message,
          path: ["config", ...issue.path],
        });
      }
    }
    const inv = plugin.invocationSchema.safeParse(spec.invocation ?? {});
    if (!inv.success) {
      for (const issue of inv.error.issues) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: issue.message,
          path: ["invocation", ...issue.path],
        });
      }
    }
  });

export type ToolStepV1 = z.infer<typeof ToolStepV1Schema>;

async function runToolStep(spec: ToolStepV1, ctx: StepContext): Promise<StepRunResult> {
  const plugin = getTool(spec.tool);
  if (!plugin) {
    return { ok: false, error: `unknown tool kind: ${spec.tool}` };
  }

  const config = plugin.configSchema.parse(spec.config ?? {});
  const invocation = plugin.invocationSchema.parse(spec.invocation ?? {});

  const resolvedCwd = resolveBindingPath(spec.cwd, { workDir: ctx.workDir, bindings: ctx.bindings });

  ctx.logger.emit("step.tool.invoke", {
    stepId: spec.id,
    tool: spec.tool,
    cwd: resolvedCwd,
    timeoutMs: spec.timeoutMs,
  });

  const abortController = new AbortController();
  const onParentAbort = (): void => abortController.abort(ctx.signal.reason);
  if (ctx.signal.aborted) {
    onParentAbort();
  } else {
    ctx.signal.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = setTimeout(() => {
    abortController.abort(new Error(`tool step timed out after ${spec.timeoutMs}ms`));
  }, spec.timeoutMs);

  try {
    const result = await plugin.invoke(
      {
        env: ctx.env,
        workDir: resolvedCwd,
        planName: ctx.planName,
        signal: abortController.signal,
        timeoutMs: spec.timeoutMs,
      },
      config,
      invocation,
    );
    return {
      ok: result.ok,
      error: result.error,
      tool: {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
        stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onParentAbort);
  }
}

registerStep({
  kind: "tool",
  schema: ToolStepV1Schema,
  run: runToolStep,
});
