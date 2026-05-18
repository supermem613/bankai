import type { Env } from "../env-runtime/env.js";
import type { RunLogger } from "../log/jsonl.js";
import type { RegistryStore } from "../registry/store.js";
import type { BankaiPlanV1 } from "../plan/schema.js";
import type {
  BankaiEnvelope,
  BankaiStepResult,
  BankaiFailure,
} from "../plan/envelope.js";
import {
  getStepHandler,
  type StepRunResult,
  type StepContext,
} from "../steps/registry.js";
import { createHandleStore } from "./handle-store.js";
import { createLifecycleScope } from "../environments/lifecycle-scope.js";
import type { ResolvedBindings } from "../bindings.js";

// runPlan: execute a BankaiPlanV1 to completion. Iterates steps in
// order. Each step receives a StepContext bound to the same logger,
// registry, handle store, scope, and abort signal so step kinds can
// share state when needed.
//
// Invariants the next editor must preserve:
//   1. Steps run sequentially in declaration order. Parallelism lives
//      INSIDE step kinds (e.g. wait evaluating multiple probes), not
//      at the orchestrator layer. This keeps causality readable.
//   2. A step failure stops the run unless the step has
//      continueOnFail: true. Test plans set this on assert steps so
//      every assertion reports.
//   3. The lifecycle scope is unwound at end regardless of success or
//      failure. Scoped resources NEVER outlive the run.
//   4. Persistent resources (setup with registerAs) are NOT torn down
//      by the scope. They are owned by the registry and outlive the
//      plan. The user reclaims them via `bankai stop <name>`.
//   5. Sub-plans (run-plan step) reuse the same logger, registry, and
//      parent abort signal but get fresh handle stores and scopes so
//      step ids are isolated and scoped resources do not leak across.

export interface RunPlanOptions {
  env: Env;
  plan: BankaiPlanV1;
  planPath: string;
  /** Repo root: the directory steps treat as their working directory by default. Resolved by resolveRepoRoot in the entry command. */
  repoRoot: string;
  logger: RunLogger;
  registry: RegistryStore;
  bindings?: ResolvedBindings;
  parentSignal?: AbortSignal;
  visibleAttachedTerminal?: boolean;
  visibleReadyEventFile?: string;
  /** When true, this is a nested run via a run-plan step. Affects logging only. */
  sub?: boolean;
}

const STEP_TAIL_BYTES = 4096;

function tail(s: string, n: number): string {
  return s.length <= n ? s : s.slice(s.length - n);
}

function toEnvelopeStep(id: string, kind: string, started: string, finished: string, durationMs: number, run: StepRunResult): BankaiStepResult {
  return {
    id,
    kind,
    ok: run.ok,
    startedAt: started,
    finishedAt: finished,
    durationMs,
    error: run.error,
    shell: run.shell
      ? {
        exitCode: run.shell.exitCode,
        stdoutBytes: run.shell.stdoutBytes,
        stderrBytes: run.shell.stderrBytes,
        stdoutTail: tail(run.shell.stdout, STEP_TAIL_BYTES),
        stderrTail: tail(run.shell.stderr, STEP_TAIL_BYTES),
      }
      : undefined,
    tool: run.tool
      ? {
        exitCode: run.tool.exitCode,
        stdoutBytes: run.tool.stdoutBytes,
        stderrBytes: run.tool.stderrBytes,
        stdoutTail: tail(run.tool.stdout, STEP_TAIL_BYTES),
        stderrTail: tail(run.tool.stderr, STEP_TAIL_BYTES),
      }
      : undefined,
    assert: run.assert,
    setup: run.setup
      ? {
        envKind: run.setup.envKind,
        registered: run.setup.registered,
        registerAs: run.setup.registerAs,
        handle: run.setup.handle,
        capabilities: run.setup.capabilities,
      }
      : undefined,
    wait: run.wait,
    stop: run.stop,
    runPlan: run.runPlan,
    attachedProcess: run.attachedProcess,
  };
}

export async function runPlan(opts: RunPlanOptions): Promise<BankaiEnvelope> {
  const { env, plan, planPath, logger, registry, repoRoot } = opts;
  const bindings = opts.bindings ?? {};
  const startedAt = env.clock.isoNow();
  const startedNow = env.clock.now();
  const ac = new AbortController();
  const onParentAbort = (): void => ac.abort(opts.parentSignal?.reason);
  if (opts.parentSignal?.aborted) {
    onParentAbort();
  } else if (opts.parentSignal) {
    opts.parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }

  const handles = createHandleStore();
  const cleanupErrors: Error[] = [];
  const scope = createLifecycleScope({
    onCleanupError: (err) => {
      const e = err instanceof Error ? err : new Error(String(err));
      cleanupErrors.push(e);
      logger.emit("scope.cleanup-error", { error: e.message });
    },
  });

  logger.emit(opts.sub ? "sub-plan.start" : "plan.start", {
    planName: plan.name,
    planPath,
    stepCount: plan.steps.length,
    bindingKeys: Object.keys(bindings).sort(),
  });

  const priorResults = new Map<string, StepRunResult>();
  const envelopeSteps: BankaiStepResult[] = [];
  let stopRequested = false;
  let firstFailure: BankaiFailure | undefined;

  for (const stepRef of plan.steps) {
    if (stopRequested) {
      logger.emit("step.skipped", { stepId: stepRef.id, reason: "earlier failure" });
      continue;
    }
    if (ac.signal.aborted) {
      logger.emit("step.skipped", { stepId: stepRef.id, reason: "aborted" });
      stopRequested = true;
      if (!firstFailure) {
        firstFailure = { stage: "internal", reason: "run aborted" };
      }
      continue;
    }
    const handler = getStepHandler(stepRef.kind);
    const stepStarted = env.clock.isoNow();
    const stepStartedNow = env.clock.now();
    logger.emit("step.start", { stepId: stepRef.id, kind: stepRef.kind });
    let runResult: StepRunResult;
    try {
      const spec = handler.schema.parse(stepRef);
      const ctx: StepContext = {
        env,
        workDir: repoRoot,
        planName: plan.name,
        planPath,
        bindings,
        signal: ac.signal,
        logger,
        visibleAttachedTerminal: opts.visibleAttachedTerminal === true,
        visibleReadyEventFile: opts.visibleReadyEventFile,
        handles,
        registry,
        scope,
        priorResults,
      };
      runResult = await handler.run(spec, ctx);
    } catch (err) {
      runResult = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    const stepFinished = env.clock.isoNow();
    const stepDuration = env.clock.now() - stepStartedNow;
    const envelopeStep = toEnvelopeStep(stepRef.id, stepRef.kind, stepStarted, stepFinished, stepDuration, runResult);
    envelopeSteps.push(envelopeStep);
    priorResults.set(stepRef.id, runResult);
    logger.emit("step.end", {
      stepId: stepRef.id,
      kind: stepRef.kind,
      ok: runResult.ok,
      error: runResult.error,
      durationMs: stepDuration,
    });
    if (!runResult.ok) {
      const continueOnFail = (stepRef as { continueOnFail?: boolean }).continueOnFail === true;
      if (!firstFailure) {
        firstFailure = {
          stage: "step",
          reason: `step "${stepRef.id}" (${stepRef.kind}) failed: ${runResult.error ?? "unknown reason"}`,
          detail: { stepId: stepRef.id, kind: stepRef.kind },
        };
      }
      if (!continueOnFail) {
        stopRequested = true;
      }
    }
  }

  if (opts.parentSignal) {
    opts.parentSignal.removeEventListener("abort", onParentAbort);
  }

  await scope.unwind();
  if (cleanupErrors.length > 0 && !firstFailure) {
    firstFailure = {
      stage: "internal",
      reason: `scope cleanup errors: ${cleanupErrors.map((e) => e.message).join("; ")}`,
    };
  }

  const finishedAt = env.clock.isoNow();
  const durationMs = env.clock.now() - startedNow;
  const ok = !firstFailure && envelopeSteps.every((s) => s.ok);
  logger.emit(opts.sub ? "sub-plan.end" : "plan.end", {
    planName: plan.name,
    ok,
    durationMs,
    stepCount: envelopeSteps.length,
  });

  return {
    ok,
    command: "run",
    startedAt,
    finishedAt,
    durationMs,
    runId: logger.runId,
    logFile: logger.logFilePath,
    planName: plan.name,
    planPath,
    steps: envelopeSteps,
    failure: firstFailure,
  };
}
