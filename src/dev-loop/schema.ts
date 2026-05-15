import { z } from "zod";

// DevLoopPlan: declarative description of a single long-running dev-server
// scenario. One file per logical dev loop. Plans live at
// <repo>/.bankai/plans/<name>.dev-loop.json by convention. Invariants the
// next editor must preserve:
//   1. schemaVersion is the discriminator for forward compatibility. A
//      future v2 must include a migrator under bankai schema migrate.
//   2. name doubles as the state key. It must be unique within a repo and
//      stable across edits. Renaming a plan orphans its state file entry.
//   3. environment.kind names a registered EnvironmentPlugin under
//      src/environments/. A plugin participates in dev-loop only if it
//      exposes a startLongRunning method (added in M4). Plans cannot
//      depend on environment plugins that lack that method.
//   4. readiness probes are an OPEN registry. Each ref's kind is
//      validated against a registered probe. Probes are evaluated in
//      order during wait-ready. ALL probes must pass for the plan to be
//      considered ready.
//   5. readyTimeoutMs caps the entire wait-ready loop. Per-probe timeouts
//      are owned by each probe spec. The orchestrator aborts the whole
//      wait when this fires.

export const ReadinessProbeRefSchema = z
  .object({
    kind: z.string().min(1),
    id: z.string().min(1),
  })
  .passthrough();

export type ReadinessProbeRef = z.infer<typeof ReadinessProbeRefSchema>;

export const DevLoopEnvironmentRefSchema = z
  .object({
    kind: z.string().min(1),
    config: z.unknown().optional(),
    setupTimeoutMs: z.number().int().positive().optional(),
  })
  .passthrough();

export type DevLoopEnvironmentRef = z.infer<typeof DevLoopEnvironmentRefSchema>;

export const DevLoopPlanV1Schema = z.object({
  schemaVersion: z.literal("1"),
  name: z
    .string()
    .min(1)
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      "dev-loop plan name must be kebab-case ASCII to be safe as a state key and lockfile name",
    ),
  description: z.string().optional(),
  environment: DevLoopEnvironmentRefSchema,
  readiness: z.array(ReadinessProbeRefSchema).default([]),
  readyTimeoutMs: z.number().int().positive().default(180_000),
});

export type DevLoopPlanV1 = z.infer<typeof DevLoopPlanV1Schema>;
