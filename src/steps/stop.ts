import { z } from "zod";
import { registerStep, type StepContext, type StepRunResult } from "./registry.js";
import { isProcessAlive, terminateProcessTree } from "../process-tree.js";
import { verifyFingerprint } from "../fingerprint.js";

// stop step kind: terminate a registered handle by name. Verifies
// fingerprint before signaling unless `force` is set. Updates the
// per-user registry to remove the entry on success.
//
// Invariants the next editor must preserve:
//   1. Stop is name-based, not pid-based. The plan may run on a host
//      that did not register the handle; cwd does not matter.
//   2. Fingerprint mismatch (alive pid, different process identity)
//      MUST refuse to signal unless force. Killing the wrong process
//      is the worst outcome of this step.
//   3. Stop is idempotent. A name that does not exist returns ok with
//      a "not registered" detail. A name whose pid is already dead
//      returns ok with a "stale cleanup" detail and removes the entry.

export const StopStepV1Schema = z.object({
  kind: z.literal("stop"),
  id: z.string().min(1),
  name: z.string().min(1),
  graceMs: z.number().int().nonnegative().default(5_000),
  force: z.boolean().default(false),
  continueOnFail: z.boolean().optional(),
});

export type StopStepV1 = z.infer<typeof StopStepV1Schema>;

async function runStopStep(spec: StopStepV1, ctx: StepContext): Promise<StepRunResult> {
  ctx.logger.emit("step.stop.begin", { stepId: spec.id, name: spec.name, graceMs: spec.graceMs, force: spec.force });
  const entry = await ctx.registry.getEntry(spec.name);
  if (!entry) {
    ctx.logger.emit("step.stop.not-registered", { stepId: spec.id, name: spec.name });
    return {
      ok: true,
      stop: {
        name: spec.name,
        killed: false,
        escalated: false,
        detail: `no registered handle named "${spec.name}"`,
      },
    };
  }

  if (!isProcessAlive(entry.pid)) {
    await ctx.registry.removeEntry(spec.name);
    ctx.logger.emit("step.stop.stale", { stepId: spec.id, name: spec.name, pid: entry.pid });
    ctx.logger.emit("registry.remove", { name: spec.name, pid: entry.pid });
    return {
      ok: true,
      stop: {
        name: spec.name,
        killed: false,
        escalated: false,
        detail: `pid ${entry.pid} was already dead. Stale registry entry removed.`,
      },
    };
  }

  if (entry.fingerprint && !spec.force) {
    const v = await verifyFingerprint(entry.fingerprint, { pid: entry.pid, env: ctx.env });
    ctx.logger.emit("step.stop.fingerprint", { stepId: spec.id, name: spec.name, matched: v.matches, detail: v.detail });
    if (!v.matches) {
      return {
        ok: false,
        error: `fingerprint mismatch for "${spec.name}" (pid ${entry.pid}). Use force=true after manual investigation.`,
        stop: {
          name: spec.name,
          killed: false,
          escalated: false,
          detail: v.detail,
          fingerprint: { matched: false, detail: v.detail, current: v.current },
        },
      };
    }
  }

  const term = await terminateProcessTree({
    pid: entry.pid,
    graceMs: spec.graceMs,
    env: ctx.env,
  });
  ctx.logger.emit("step.stop.terminated", {
    stepId: spec.id,
    name: spec.name,
    pid: entry.pid,
    killed: term.killed,
    escalated: term.escalated,
    detail: term.detail,
  });

  if (term.killed) {
    await ctx.registry.removeEntry(spec.name);
    ctx.logger.emit("registry.remove", { name: spec.name, pid: entry.pid });
  }

  return {
    ok: term.killed,
    error: term.killed ? undefined : term.detail,
    stop: {
      name: spec.name,
      killed: term.killed,
      escalated: term.escalated,
      detail: term.detail,
    },
  };
}

registerStep({
  kind: "stop",
  schema: StopStepV1Schema,
  run: runStopStep,
});
