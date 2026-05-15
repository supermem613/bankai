import { z } from "zod";
import { resolve as resolvePath, isAbsolute as isAbsolutePath } from "node:path";
import { registerStep, type StepContext } from "./registry.js";
import { getTool } from "../tools/registry.js";
import type { BankaiStepResult } from "../schema/envelope.js";

// Tool step kind: closed step kind that dispatches to an OPEN registry of tool
// plugins under src/tools/. A tool step references a tool by kind, supplies a
// per-step config and invocation, and lets the tool plugin own all tactical
// knowledge about the binary it wraps (entrypoint discovery, retry, refresh,
// argv composition).
//
// Invariants the next editor must preserve:
//   1. The outer schema is closed. spec.config and spec.invocation are
//      z.unknown at the outer layer and are parsed against the plugin schemas
//      via superRefine at scenario preflight. This means a typo in tool
//      config aborts at validation, before any step runs, just like a typo
//      in shell args.
//   2. Inner config and invocation are parsed twice on a successful run.
//      Once during superRefine for fail-fast and once inside run to obtain
//      the canonical defaulted values. This duplicate parse is intentional.
//      It is cheap and it keeps the StepHandler generic typing simple.
//   3. cwd is resolved against ctx.workDir when relative. Same contract as
//      the shell step. The tool plugin receives the resolved absolute path
//      via ToolContext.workDir.
//   4. timeoutMs bounds the WHOLE step including any per-attempt retries the
//      plugin runs. The plugin's own attemptTimeoutMs is per attempt and
//      should be smaller than the step timeout if retries are configured.
//   5. The signal in ToolContext is wired to the step timeout. Plugins MUST
//      observe abort and stop spawning further attempts when it fires.

export const ToolStepV1Schema = z
  .object({
    kind: z.literal("tool"),
    id: z.string().min(1),
    tool: z.string().min(1),
    config: z.unknown().optional(),
    invocation: z.unknown().optional(),
    cwd: z.string().optional(),
    timeoutMs: z.number().int().positive().default(60_000),
  })
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

async function runToolStep(
  spec: ToolStepV1,
  ctx: StepContext,
): Promise<Omit<BankaiStepResult, "id" | "kind">> {
  const start = ctx.env.clock.now();
  const plugin = getTool(spec.tool);
  if (!plugin) {
    return {
      ok: false,
      durationMs: ctx.env.clock.now() - start,
      stdout: "",
      stderr: "",
      error: `unknown tool kind: ${spec.tool}`,
    };
  }

  const config = plugin.configSchema.parse(spec.config ?? {});
  const invocation = plugin.invocationSchema.parse(spec.invocation ?? {});

  const resolvedCwd = spec.cwd
    ? isAbsolutePath(spec.cwd)
      ? spec.cwd
      : resolvePath(ctx.workDir, spec.cwd)
    : ctx.workDir;

  const abortController = new AbortController();
  const timer = setTimeout(() => {
    abortController.abort(new Error(`tool step timed out after ${spec.timeoutMs}ms`));
  }, spec.timeoutMs);

  try {
    const result = await plugin.invoke(
      {
        env: ctx.env,
        workDir: resolvedCwd,
        scenarioName: ctx.scenarioName,
        signal: abortController.signal,
        timeoutMs: spec.timeoutMs,
      },
      config,
      invocation,
    );
    return {
      ok: result.ok,
      durationMs: ctx.env.clock.now() - start,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error,
    };
  } catch (err) {
    return {
      ok: false,
      durationMs: ctx.env.clock.now() - start,
      stdout: "",
      stderr: "",
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

registerStep({
  kind: "tool",
  schema: ToolStepV1Schema,
  run: runToolStep,
});
