import { z } from "zod";
import type { Env } from "../env-runtime/env.js";
import type { RunLogger } from "../log/jsonl.js";
import type { LifecycleScope } from "../environments/lifecycle-scope.js";
import type { RegistryStore } from "../registry/store.js";
import type { HandleStore } from "../orchestrator/handle-store.js";
import type { ProcessHandle } from "../registry/types.js";
import type { ResolvedBindings } from "../bindings.js";
import type {
  AssertStepResultSchema,
  WaitStepResultSchema,
  StopStepResultSchema,
  RunPlanStepResultSchema,
  AttachedProcessStepResultSchema,
} from "../plan/envelope.js";

// StepHandler registry: closed set of step kinds (shell, tool, assert,
// setup, wait, stop, run-plan), each owns its zod schema and run
// function. Invariants the next editor must preserve:
//   1. Registration is global at module load. Step modules call
//      registerStep from their top level so importing the index
//      registers everything.
//   2. The registry is the source of truth for "valid step kind".
//      Adding a new kind requires a new file under src/steps/ and an
//      import in src/steps/index.ts. There is intentionally no
//      runtime plugin discovery.
//   3. The orchestrator validates each step's spec against the
//      handler's schema before calling run. Handlers can assume the
//      spec is well-formed.
//   4. Handlers return a discriminated kind-specific result shape.
//      The orchestrator wraps it with id/kind/startedAt/finishedAt/
//      durationMs to produce a BankaiStepResult.

export interface StepContext {
  env: Env;
  /** Working directory for resolving relative paths inside step config. Plan-relative. */
  workDir: string;
  /** Resolved run-time bindings declared by the plan and supplied by the caller. */
  bindings: ResolvedBindings;
  planName: string;
  planPath: string;
  signal: AbortSignal;
  logger: RunLogger;
  /** True only when the CLI caller explicitly confirmed this run owns a visible attached terminal. */
  visibleAttachedTerminal: boolean;
  /** Internal one-shot event path used by a parent launcher waiting for attached readiness. */
  visibleReadyEventFile?: string;
  /** Per-run map of step id to ProcessHandle for non-registered setup steps. */
  handles: HandleStore;
  /** Per-user registry store for setup steps that use registerAs. */
  registry: RegistryStore;
  /** LifecycleScope used to tear down scoped resources at plan end. */
  scope: LifecycleScope;
  /** Prior step results, keyed by id, for steps that consume earlier output (e.g. assert). */
  priorResults: Map<string, StepRunResult>;
}

// In-memory step result. Carries the FULL stdout/stderr (bounded by
// maxBufferBytes) so downstream assert steps can match against the
// real content. The envelope-facing version (BankaiStepResult) carries
// only a tail; the orchestrator produces it via toEnvelope().

export interface ShellStepRun {
  exitCode?: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
}

export interface ToolStepRun {
  exitCode?: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
}

export interface SetupStepRun {
  envKind: string;
  registered: boolean;
  registerAs?: string;
  handle?: ProcessHandle;
  capabilities?: unknown;
}

export interface StepRunResult {
  ok: boolean;
  error?: string;
  shell?: ShellStepRun;
  tool?: ToolStepRun;
  assert?: z.infer<typeof AssertStepResultSchema>;
  setup?: SetupStepRun;
  wait?: z.infer<typeof WaitStepResultSchema>;
  stop?: z.infer<typeof StopStepResultSchema>;
  runPlan?: z.infer<typeof RunPlanStepResultSchema>;
  attachedProcess?: z.infer<typeof AttachedProcessStepResultSchema>;
}

export interface StepHandler<S extends z.ZodTypeAny> {
  kind: string;
  schema: S;
  run(spec: z.infer<S>, ctx: StepContext): Promise<StepRunResult>;
}

type AnyStepHandler = StepHandler<z.ZodTypeAny>;

const registry = new Map<string, AnyStepHandler>();

export function registerStep<S extends z.ZodTypeAny>(handler: StepHandler<S>): void {
  if (registry.has(handler.kind)) {
    throw new Error(`step kind already registered: ${handler.kind}`);
  }
  registry.set(handler.kind, handler as AnyStepHandler);
}

export function getStepHandler(kind: string): AnyStepHandler {
  const handler = registry.get(kind);
  if (!handler) {
    throw new Error(`unknown step kind: ${kind}`);
  }
  return handler;
}

export function listRegisteredStepKinds(): string[] {
  return [...registry.keys()].sort();
}

// Test-only escape hatch. Production code MUST NOT call this.
export function unregisterStepForTesting(kind: string): void {
  registry.delete(kind);
}
