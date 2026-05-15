import { z } from "zod";
import type { Env } from "../env-runtime/env.js";
import type { BankaiStepResult } from "../schema/envelope.js";

// StepHandler registry: closed set of step kinds, each owns its zod schema and
// run function. Invariants the next editor must preserve:
//   1. Registration is global at module load. Step modules call registerStep
//      from their top level so importing the index registers everything.
//   2. The registry is the source of truth for "valid step kind". Adding a
//      new kind requires a new file under src/steps/ and an import in
//      src/steps/index.ts. There is intentionally no plugin discovery.
//   3. The orchestrator validates each step's spec against the handler's
//      schema before calling run. Handlers can assume the spec is well-formed.

export interface StepContext {
  env: Env;
  workDir: string;
  scenarioName: string;
}

export interface StepHandler<S extends z.ZodTypeAny> {
  kind: string;
  schema: S;
  run(spec: z.infer<S>, ctx: StepContext): Promise<Omit<BankaiStepResult, "id" | "kind">>;
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
