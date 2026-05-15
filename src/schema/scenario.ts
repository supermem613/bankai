import { z } from "zod";

// ScenarioV1 is the test-side spec contract. Invariants the next editor must
// preserve:
//   1. schemaVersion is the discriminant for forward-compatible evolution.
//      Future ScenarioV2 adds new kinds without breaking V1 readers. Bumping
//      requires a migrator under `bankai schema migrate`.
//   2. Step and assertion shapes are validated by their registered handlers
//      not by this top-level schema. The pass-through shape here keeps
//      the contract pluggable as new step kinds register at startup.
//   3. id values must be unique within their array. The orchestrator enforces
//      this after parse so error messages can cite the duplicate.

export const StepRefSchema = z
  .object({
    kind: z.string().min(1),
    id: z.string().min(1),
  })
  .passthrough();

export type StepRef = z.infer<typeof StepRefSchema>;

export const AssertionRefSchema = z
  .object({
    kind: z.string().min(1),
    id: z.string().min(1),
  })
  .passthrough();

export type AssertionRef = z.infer<typeof AssertionRefSchema>;

export const ScenarioV1Schema = z.object({
  schemaVersion: z.literal("1"),
  name: z.string().min(1),
  description: z.string().optional(),
  steps: z.array(StepRefSchema).default([]),
  assertions: z.array(AssertionRefSchema).default([]),
});

export type ScenarioV1 = z.infer<typeof ScenarioV1Schema>;
