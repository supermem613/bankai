import { z } from "zod";

// Registry shapes. The registry is a per-user file at
// <env.home>/.bankai/state/registry.json that records every persisted
// handle (a setup step run with `registerAs: "name"`).
//
// Invariants the next editor must preserve:
//   1. Entries are keyed by the user-chosen `name` from a setup step's
//      registerAs field. NEVER planName, because two distinct plans may
//      register handles for different services.
//   2. `cwd` is captured at registration so `bankai status` can show
//      which directory the handle was registered from. The orchestrator
//      does NOT use cwd at status or stop time. Stop is name-based, not
//      cwd-based.
//   3. Entries NEVER persist secrets or full env. Only the operational
//      handle. A future env field would be a security regression.
//   4. ProcessFingerprint is captured at registration. `bankai stop`
//      verifies fingerprint before signaling so a reused pid cannot be
//      mistakenly killed.
//   5. StopStrategy is persisted so that `bankai stop` (possibly from a
//      different bankai process) can deliver the configured stop input
//      to a long-lived child that outlived the original plan process.

// Declarative stop strategy for managed processes that require specific
// stdin input to exit gracefully rather than SIGTERM.
export const StopStrategySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("stdin"),
    input: z.string().min(1),
    graceMs: z.number().int().nonnegative().optional(),
    stdinFile: z.string().min(1),
  }).strict(),
]);

export type StopStrategy = z.infer<typeof StopStrategySchema>;

export const ProcessFingerprintSchema = z.object({
  creationTime: z.string().min(1),
  commandLine: z.string(),
});

export type ProcessFingerprint = z.infer<typeof ProcessFingerprintSchema>;

export const ReadinessObservationSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  ok: z.boolean(),
  detail: z.string(),
  checkedAt: z.string().min(1),
});

export type ReadinessObservation = z.infer<typeof ReadinessObservationSchema>;

// ProcessHandle is the operational shape of a started process. Both
// scoped setup steps (no registerAs) and persistent setup steps (with
// registerAs) produce one. Readiness probes consume it. The registry
// extends it with name, planName, planPath, cwd, registeredAt for the
// persisted case.
export const ProcessHandleSchema = z.object({
  pid: z.number().int().positive(),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  workDir: z.string().min(1),
  envKind: z.string().min(1),
  logFile: z.string().min(1),
  logStartOffset: z.number().int().nonnegative().default(0),
  fingerprint: ProcessFingerprintSchema.optional(),
  stop: StopStrategySchema.optional(),
  control: z.object({
    stopRequestFile: z.string().min(1),
    stopDoneFile: z.string().min(1),
  }).strict().optional(),
  evidence: z.object({
    transcriptFile: z.string().min(1).optional(),
    detail: z.string().min(1).optional(),
    lastResult: z.object({
      ok: z.boolean(),
      finishedAt: z.string().min(1),
      detail: z.string().min(1),
      exitCode: z.number().int().optional(),
      signal: z.string().optional(),
    }).strict().optional(),
  }).strict().optional(),
});

export type ProcessHandle = z.infer<typeof ProcessHandleSchema>;

export const RegistryEntrySchema = ProcessHandleSchema.extend({
  name: z.string().min(1),
  planName: z.string().min(1),
  planPath: z.string().min(1),
  cwd: z.string().min(1),
  registeredAt: z.string().min(1),
});

export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;

export const RegistryFileSchema = z.object({
  schemaVersion: z.literal("1"),
  entries: z.record(z.string().min(1), RegistryEntrySchema).default({}),
});

export type RegistryFile = z.infer<typeof RegistryFileSchema>;
