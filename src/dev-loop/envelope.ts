import { z } from "zod";

// BankaiDevLoopEnvelope is the stable JSON contract emitted by every
// `bankai dev-loop ...` command when --json is passed. Invariants the next
// editor must preserve:
//   1. schemaVersion is required. Consumers may refuse unknown versions.
//   2. ok is a strict boolean. Present even when failure is set, so a single
//      branch on envelope.ok suffices for callers.
//   3. command names which subcommand produced the envelope. This lets a
//      single envelope shape serve start, status, wait-ready, and stop
//      without command-specific union types. The few command-specific
//      fields go under the optional state, observation, or actions keys.
//   4. state, when present, is the snapshot of the dev-loop entry as
//      persisted in .bankai/state/dev-loop.json. NEVER includes secrets
//      or full env. Only the operational handle.
//   5. observations records readiness probe results from a wait-ready run
//      or from a status query that asked for a one-shot probe. Empty
//      array means no probes were evaluated this call.
//   6. failure.stage names which phase aborted. Same pattern as the test
//      envelope so consumers can branch identically.

export const ProcessFingerprintSchema = z.object({
  creationTime: z.string().min(1),
  commandLine: z.string(),
});

export type ProcessFingerprint = z.infer<typeof ProcessFingerprintSchema>;

export const DevLoopStateEntrySchema = z.object({
  schemaVersion: z.literal("1"),
  planName: z.string().min(1),
  startedAt: z.string().min(1),
  pid: z.number().int().positive(),
  fingerprint: ProcessFingerprintSchema,
  workDir: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  logFile: z.string().min(1),
  logStartOffset: z.number().int().nonnegative(),
  envKind: z.string().min(1),
});

export type DevLoopStateEntry = z.infer<typeof DevLoopStateEntrySchema>;

export const DevLoopStateFileSchema = z.object({
  schemaVersion: z.literal("1"),
  entries: z.record(z.string(), DevLoopStateEntrySchema).default({}),
});

export type DevLoopStateFile = z.infer<typeof DevLoopStateFileSchema>;

export const ReadinessObservationSchema = z.object({
  id: z.string(),
  kind: z.string(),
  ok: z.boolean(),
  detail: z.string(),
  checkedAt: z.string(),
});

export type ReadinessObservation = z.infer<typeof ReadinessObservationSchema>;

export const DevLoopFailureSchema = z.object({
  stage: z.enum([
    "validation",
    "lock",
    "already-running",
    "not-running",
    "env-setup",
    "spawn",
    "wait-ready",
    "stop",
    "fingerprint-mismatch",
  ]),
  id: z.string(),
  reason: z.string(),
});

export type DevLoopFailure = z.infer<typeof DevLoopFailureSchema>;

export interface BankaiDevLoopEnvelope {
  schemaVersion: "1";
  ok: boolean;
  command: "start" | "status" | "wait-ready" | "stop";
  plan: string;
  durationMs: number;
  state?: DevLoopStateEntry;
  observations: ReadinessObservation[];
  failure?: DevLoopFailure;
}
