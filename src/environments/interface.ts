import { z } from "zod";
import type { Env } from "../env-runtime/env.js";
import type { LifecycleScope } from "./lifecycle-scope.js";

// EnvironmentPlugin: the open extension point for the bankai engine. While
// step kinds and assertion kinds are intentionally closed, an environment
// plugin can be added to teach the engine about a new dev-loop target like
// augloop or a future M365 environment. Invariants the next editor must
// preserve:
//   1. doctor must be safe to call any time without side effects on the
//      target environment. It performs structural checks like "is the CLI on
//      PATH" or "is the config file readable". Service-touching probes go in
//      doctorLive when present.
//   2. setup must block until the environment is ready for the first step to
//      run. Returning early with a "wait for ready" promise is a foot-gun
//      because the orchestrator already serializes setup before steps.
//   3. Every resource setup acquires must be registered with ctx.scope so a
//      partial setup throw releases what was already created. Forgetting this
//      causes leaks that surface as port-in-use or stale-pid errors on later
//      runs.
//   4. capabilities is the typed surface a step or assertion can read. It must
//      not expose raw process handles. Expose ports, endpoints, file paths
//      and similar values instead. This keeps the closed step registry from
//      reaching into env internals.

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

export interface EnvironmentContext {
  env: Env;
  workDir: string;
  scenarioName: string;
  scope: LifecycleScope;
  signal: AbortSignal;
  timeoutMs: number;
}

export interface EnvironmentHandle<Caps = unknown> {
  capabilities: Caps;
  teardown(): Promise<void>;
}

export interface EnvironmentPlugin<
  C extends z.ZodTypeAny = z.ZodTypeAny,
  Caps = unknown,
> {
  kind: string;
  configSchema: C;
  doctor(env: Env): Promise<CheckResult[]>;
  doctorLive?(env: Env, config: z.infer<C>): Promise<CheckResult[]>;
  setup(ctx: EnvironmentContext, config: z.infer<C>): Promise<EnvironmentHandle<Caps>>;
}
