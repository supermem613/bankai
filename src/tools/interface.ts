import type { z } from "zod";
import type { Env } from "../env-runtime/env.js";

// ToolPlugin: open extension point for invoking external CLIs deterministically
// from a scenario step. While step kinds and assertion kinds are intentionally
// closed, a tool plugin teaches bankai how to invoke a specific binary like
// kash, with all the tactical knowledge (entrypoint discovery, retry, refresh,
// argv composition) owned by the plugin and never by skill text. Invariants
// the next editor must preserve:
//   1. invoke must be deterministic over (env, config, invocation). Given the
//      same inputs and a healthy binary it must always produce the same
//      observable side effects. No hidden environment reads. No clock-based
//      branching. The Env handed in is the only host-state surface.
//   2. doctor takes config because tool plugins typically have configurable
//      binary paths. Unlike environment plugins where doctor is config-free
//      and doctorLive may use config, tools collapse the two: a single doctor
//      that may inspect config is sufficient since tools have no long-lived
//      state to probe.
//   3. invocationSchema and configSchema are both zod schemas and are parsed
//      separately. The tool step kind validates both at scenario preflight
//      via superRefine. Invocation is per-step input. Config is per-step
//      tuning of how the tool runs.
//   4. The result mirrors a step result subset: ok, exitCode, stdout, stderr,
//      error, durationMs. Tools that produce structured output write to a
//      file path declared in invocation. Assertions read those files via
//      assert-text-contains. There is no structured payload in the envelope
//      yet; that is reserved for a future schemaVersion bump.

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

export interface ToolContext {
  env: Env;
  workDir: string;
  scenarioName: string;
  signal: AbortSignal;
  timeoutMs: number;
}

export interface ToolInvocationResult {
  ok: boolean;
  durationMs: number;
  exitCode?: number;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface ToolPlugin<
  C extends z.ZodTypeAny = z.ZodTypeAny,
  I extends z.ZodTypeAny = z.ZodTypeAny,
> {
  kind: string;
  configSchema: C;
  invocationSchema: I;
  doctor(env: Env, config: z.infer<C>): Promise<CheckResult[]>;
  invoke(
    ctx: ToolContext,
    config: z.infer<C>,
    invocation: z.infer<I>,
  ): Promise<ToolInvocationResult>;
}
