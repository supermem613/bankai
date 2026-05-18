import { z } from "zod";
import { ProcessHandleSchema, ReadinessObservationSchema, ProcessFingerprintSchema } from "../registry/types.js";

// BankaiEnvelope: the unified result shape returned by every bankai
// command. `command` discriminates which optional fields are populated.
//
// Invariants the next editor must preserve:
//   1. `ok` is the canonical pass/fail. Tests, scripts, and CI consume
//      this single field. It is the AND of every required step ok.
//   2. `command` enumerates the verbs. Adding a new verb requires
//      extending this enum.
//   3. Per-step results live in `steps`. A run command always populates
//      this. A status/stop/doctor command may leave it empty.
//   4. Readiness observations are flattened into per-step results
//      (under StepResult.observations) AND collected at the envelope
//      level for the whole-run "any wait succeeded" question.
//   5. failure is set iff ok=false. It carries a stable `stage` enum
//      so consumers can branch on the failure type without scraping
//      the human reason.

export const BankaiFailureSchema = z.object({
  stage: z.enum([
    "validation",
    "load-plan",
    "log",
    "step",
    "registry",
    "fingerprint",
    "wait-timeout",
    "stop",
    "doctor",
    "internal",
  ]),
  reason: z.string().min(1),
  detail: z.record(z.string(), z.unknown()).optional(),
});

export type BankaiFailure = z.infer<typeof BankaiFailureSchema>;

export const ShellStepResultSchema = z.object({
  exitCode: z.number().int().optional(),
  stdoutFile: z.string().optional(),
  stdoutBytes: z.number().int().nonnegative(),
  stderrBytes: z.number().int().nonnegative(),
  /** Truncated tail of stdout for human reporting. Full content lives in the JSONL log. */
  stdoutTail: z.string().default(""),
  stderrTail: z.string().default(""),
});

export const ToolStepResultSchema = z.object({
  exitCode: z.number().int().optional(),
  stdoutBytes: z.number().int().nonnegative(),
  stderrBytes: z.number().int().nonnegative(),
  stdoutTail: z.string().default(""),
  stderrTail: z.string().default(""),
});

export const AssertStepResultSchema = z.object({
  detail: z.string(),
});

export const SetupStepResultSchema = z.object({
  envKind: z.string(),
  registered: z.boolean(),
  registerAs: z.string().optional(),
  handle: ProcessHandleSchema.optional(),
  capabilities: z.unknown().optional(),
});

export const WaitStepResultSchema = z.object({
  attempts: z.number().int().nonnegative(),
  observations: z.array(ReadinessObservationSchema),
  allReady: z.boolean(),
});

export const StopStepResultSchema = z.object({
  name: z.string(),
  killed: z.boolean(),
  escalated: z.boolean(),
  detail: z.string(),
  fingerprint: z
    .object({
      matched: z.boolean(),
      detail: z.string(),
      current: ProcessFingerprintSchema.optional(),
    })
    .optional(),
});

export const RunPlanStepResultSchema = z.object({
  planName: z.string(),
  planPath: z.string(),
  inner: z.unknown(),
});

export const AttachedProcessStepResultSchema = z.object({
  exitCode: z.number().int().optional(),
  signal: z.string().optional(),
  stoppedBy: z.enum(["exit", "ctrl-c", "timeout"]).default("exit"),
  escalated: z.boolean().default(false),
  detail: z.string(),
});

export const WriteFileStepResultSchema = z.object({
  file: z.string(),
  bytes: z.number().int().nonnegative(),
});

export const BankaiStepResultSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  ok: z.boolean(),
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
  durationMs: z.number().int().nonnegative(),
  error: z.string().optional(),
  shell: ShellStepResultSchema.optional(),
  tool: ToolStepResultSchema.optional(),
  assert: AssertStepResultSchema.optional(),
  setup: SetupStepResultSchema.optional(),
  wait: WaitStepResultSchema.optional(),
  stop: StopStepResultSchema.optional(),
  runPlan: RunPlanStepResultSchema.optional(),
  attachedProcess: AttachedProcessStepResultSchema.optional(),
  writeFile: WriteFileStepResultSchema.optional(),
});

export type BankaiStepResult = z.infer<typeof BankaiStepResultSchema>;

export const BankaiEnvelopeSchema = z.object({
  ok: z.boolean(),
  command: z.enum(["run", "status", "logs", "stop", "doctor", "update"]),
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
  durationMs: z.number().int().nonnegative(),
  runId: z.string().min(1),
  logFile: z.string(),
  planName: z.string().optional(),
  planPath: z.string().optional(),
  steps: z.array(BankaiStepResultSchema).default([]),
  /** For status: the registry entries listed. For stop: the entry that was stopped. */
  registry: z.array(z.unknown()).optional(),
  /** For doctor: the structured check results. */
  checks: z
    .array(
      z.object({
        name: z.string(),
        ok: z.boolean(),
        detail: z.string(),
        hint: z.string().optional(),
      }),
    )
    .optional(),
  failure: BankaiFailureSchema.optional(),
});

export type BankaiEnvelope = z.infer<typeof BankaiEnvelopeSchema>;
