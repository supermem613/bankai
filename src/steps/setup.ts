import { z } from "zod";
import { registerStep, type StepContext, type StepRunResult } from "./registry.js";
import { getEnvironment } from "../environments/registry.js";
import type { ProcessHandle, RegistryEntry } from "../registry/types.js";
import { BindingConditionSchema, BindingPathRefSchema, resolveBindingPath } from "../bindings.js";

// setup step kind: invoke an environment plugin (noop, managed-process,
// future docker, ...). Two paths through this step:
//
//   1. Without registerAs: SCOPED. Plugin's setup() is called. The
//      handle is registered in the per-run HandleStore. LifecycleScope
//      tears it down at plan end.
//   2. With registerAs: PERSISTENT. Plugin's startLongRunning() is
//      called (must be implemented by plugin). The handle is written
//      to the per-user registry under the registerAs name. The handle
//      OUTLIVES the plan; bankai stop is needed to terminate it.
//
// Invariants the next editor must preserve:
//   1. The orchestrator chooses the path based on registerAs presence.
//      Plugins do not see registerAs.
//   2. registerAs uniqueness is enforced at the registry layer with
//      withLock so two parallel bankai runs cannot both write the same
//      name. The setup step rejects if a registered name is already
//      live (alive pid + matching plugin kind); a stale entry is
//      cleaned and replaced.
//   3. Capabilities returned by setup() are NOT serialized into the
//      step result. Steps inside the plan address the env via step id
//      through ctx.handles; capabilities are reserved for future use.

export const SetupStepV1Schema = z
  .object({
    kind: z.literal("setup"),
    id: z.string().min(1),
    env: z.string().min(1),
    config: z.unknown().optional(),
    registerAs: z.string().min(1).optional(),
    setupTimeoutMs: z.number().int().positive().default(30_000),
    cwd: BindingPathRefSchema.optional(),
    continueOnFail: z.boolean().optional(),
    alwaysRun: z.boolean().optional(),
    runIf: BindingConditionSchema.optional(),
    skipIf: BindingConditionSchema.optional(),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const plugin = getEnvironment(spec.env);
    if (!plugin) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `unknown environment kind: ${spec.env}`,
        path: ["env"],
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
  });

export type SetupStepV1 = z.infer<typeof SetupStepV1Schema>;

import { isProcessAlive } from "../process-tree.js";
import { verifyFingerprint } from "../fingerprint.js";

async function runScopedSetup(
  spec: SetupStepV1,
  ctx: StepContext,
  resolvedCwd: string,
): Promise<StepRunResult> {
  const plugin = getEnvironment(spec.env)!;
  const config = plugin.configSchema.parse(spec.config ?? {});
  const ac = new AbortController();
  const onAbort = (): void => ac.abort(ctx.signal.reason);
  if (ctx.signal.aborted) {
    onAbort();
  } else {
    ctx.signal.addEventListener("abort", onAbort, { once: true });
  }
  ctx.logger.emit("step.setup.scoped.begin", {
    stepId: spec.id,
    env: spec.env,
    cwd: resolvedCwd,
  });
  try {
    const handle = await plugin.setup(
      {
        env: ctx.env,
        workDir: resolvedCwd,
        planName: ctx.planName,
        scope: ctx.scope,
        signal: ac.signal,
        timeoutMs: spec.setupTimeoutMs,
      },
      config,
    );
    ctx.scope.defer(() => handle.teardown());
    if (handle.processHandle) {
      ctx.handles.register(spec.id, handle.processHandle);
    }
    ctx.logger.emit("step.setup.scoped.ready", {
      stepId: spec.id,
      env: spec.env,
      hasProcessHandle: Boolean(handle.processHandle),
    });
    return {
      ok: true,
      setup: {
        envKind: spec.env,
        registered: false,
        handle: handle.processHandle,
        capabilities: handle.capabilities,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      setup: { envKind: spec.env, registered: false },
    };
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
  }
}

async function runPersistentSetup(
  spec: SetupStepV1,
  ctx: StepContext,
  resolvedCwd: string,
  registerAs: string,
): Promise<StepRunResult> {
  const plugin = getEnvironment(spec.env)!;
  if (!plugin.startLongRunning) {
    return {
      ok: false,
      error: `environment kind "${spec.env}" does not support registerAs (no startLongRunning surface)`,
      setup: { envKind: spec.env, registered: false, registerAs },
    };
  }
  const config = plugin.configSchema.parse(spec.config ?? {});
  const ac = new AbortController();
  const onAbort = (): void => ac.abort(ctx.signal.reason);
  if (ctx.signal.aborted) {
    onAbort();
  } else {
    ctx.signal.addEventListener("abort", onAbort, { once: true });
  }
  ctx.logger.emit("step.setup.persistent.begin", {
    stepId: spec.id,
    env: spec.env,
    registerAs,
    cwd: resolvedCwd,
  });
  try {
    // Liveness pre-check on any existing entry. If alive and same env
    // kind, refuse. If dead, drop and replace.
    const handle = await ctx.registry.withLock<{ kind: "ok"; entry: RegistryEntry; handle: ProcessHandle } | { kind: "already-running"; entry: RegistryEntry }>(
      async (current) => {
        const existing = current.entries[registerAs];
        if (existing) {
          const alive = isProcessAlive(existing.pid);
          if (alive) {
            if (existing.fingerprint) {
              const v = await verifyFingerprint(existing.fingerprint, { pid: existing.pid, env: ctx.env });
              if (v.matches) {
                ctx.logger.emit("step.setup.persistent.already-running", { stepId: spec.id, registerAs, pid: existing.pid });
                return { next: current, result: { kind: "already-running", entry: existing } };
              }
            } else {
              ctx.logger.emit("step.setup.persistent.already-running", { stepId: spec.id, registerAs, pid: existing.pid });
              return { next: current, result: { kind: "already-running", entry: existing } };
            }
          }
          ctx.logger.emit("step.setup.persistent.stale-cleanup", { stepId: spec.id, registerAs, pid: existing.pid });
        }
        const newHandle = await plugin.startLongRunning!(
          {
            env: ctx.env,
            workDir: resolvedCwd,
            planName: ctx.planName,
            signal: ac.signal,
            timeoutMs: spec.setupTimeoutMs,
            logger: ctx.logger,
          },
          config,
        );
        const entry: RegistryEntry = {
          name: registerAs,
          planName: ctx.planName,
          planPath: ctx.planPath,
          cwd: resolvedCwd,
          envKind: spec.env,
          registeredAt: ctx.env.clock.isoNow(),
          pid: newHandle.pid,
          command: newHandle.command,
          args: newHandle.args,
          originalCommand: newHandle.originalCommand,
          originalArgs: newHandle.originalArgs,
          workDir: newHandle.workDir,
          logFile: newHandle.logFile,
          logStartOffset: newHandle.logStartOffset,
          fingerprint: newHandle.fingerprint,
          stop: newHandle.stop,
        };
        const nextEntries = { ...current.entries, [registerAs]: entry };
        ctx.logger.emit("registry.put", { name: registerAs, pid: entry.pid, envKind: entry.envKind });
        return { next: { ...current, entries: nextEntries }, result: { kind: "ok", entry, handle: newHandle } };
      },
    );

    if (handle.kind === "already-running") {
      return {
        ok: false,
        error: `a handle named "${registerAs}" is already running (pid ${handle.entry.pid}). Run \`bankai stop ${registerAs}\` first.`,
        setup: { envKind: spec.env, registered: false, registerAs, handle: handle.entry },
      };
    }
    ctx.handles.register(spec.id, handle.handle);
    ctx.logger.emit("step.setup.persistent.ready", {
      stepId: spec.id,
      env: spec.env,
      registerAs,
      pid: handle.entry.pid,
    });
    return {
      ok: true,
      setup: {
        envKind: spec.env,
        registered: true,
        registerAs,
        handle: handle.handle,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      setup: { envKind: spec.env, registered: false, registerAs },
    };
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
  }
}

async function runSetupStep(spec: SetupStepV1, ctx: StepContext): Promise<StepRunResult> {
  const resolvedCwd = resolveBindingPath(spec.cwd, { workDir: ctx.workDir, bindings: ctx.bindings });
  if (spec.registerAs) {
    return runPersistentSetup(spec, ctx, resolvedCwd, spec.registerAs);
  }
  return runScopedSetup(spec, ctx, resolvedCwd);
}

registerStep({
  kind: "setup",
  schema: SetupStepV1Schema,
  run: runSetupStep,
});
