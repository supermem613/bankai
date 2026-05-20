import { z } from "zod";
import type { Env } from "../env-runtime/env.js";
import type { LifecycleScope } from "./lifecycle-scope.js";
import type { ProcessHandle } from "../registry/types.js";
import type { RunLogger } from "../log/jsonl.js";

// EnvironmentPlugin: the open extension point for the bankai engine. While
// step kinds and assertion kinds are intentionally closed, an environment
// plugin can be added to teach the engine about a new target such as a managed
// process, container, or remote service. Invariants the next editor must
// preserve:
//   1. doctor must be safe to call any time without side effects on the
//      target environment. It performs structural checks like "is the CLI on
//      PATH" or "is the config file readable". Service-touching probes go in
//      doctorLive when present.
//   2. setup must block until the environment is ready for the next step to
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
//   5. startLongRunning is OPTIONAL. Plugins that participate in setup steps
//      with `registerAs` implement it; plugins that only support scoped setup
//      do not. The orchestrator refuses to register a handle whose env kind
//      has no startLongRunning. The split between setup (scoped lifecycle,
//      child attached to LifecycleScope, torn down at plan end) and
//      startLongRunning (orphaned-from-bankai lifecycle, persistent handle
//      returned for later stop) keeps the two surfaces from stepping on each
//      other. A plugin that wants to support both implements both methods.

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

export interface EnvironmentContext {
  env: Env;
  workDir: string;
  planName: string;
  scope: LifecycleScope;
  signal: AbortSignal;
  timeoutMs: number;
}

export interface EnvironmentHandle<Caps = unknown> {
  capabilities: Caps;
  /** Optional process handle exposed to readiness probes for scoped setups. Most scoped envs do not have one. */
  processHandle?: ProcessHandle;
  teardown(): Promise<void>;
}

export interface EnvironmentPlugin<
  C extends z.ZodTypeAny = z.ZodTypeAny,
  Caps = unknown,
> {
  kind: string;
  configSchema: C;
  doctor(env: Env, config?: z.infer<C>): Promise<CheckResult[]>;
  doctorLive?(env: Env, config: z.infer<C>): Promise<CheckResult[]>;
  setup(ctx: EnvironmentContext, config: z.infer<C>): Promise<EnvironmentHandle<Caps>>;
  startLongRunning?(ctx: LongRunningContext, config: z.infer<C>): Promise<ProcessHandle>;
}

export interface LongRunningContext {
  env: Env;
  workDir: string;
  planName: string;
  signal: AbortSignal;
  timeoutMs: number;
  /** Optional run logger so environment plugins can emit JSONL events for
   * command resolution, spawn, and similar lifecycle observability. */
  logger?: RunLogger;
}
