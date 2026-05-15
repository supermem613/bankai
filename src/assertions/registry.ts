import { z } from "zod";
import type { BankaiAssertionResult, BankaiStepResult } from "../schema/envelope.js";
import type { Env } from "../env-runtime/env.js";

// AssertionHandler registry: closed set of assertion kinds, each owns its
// zod schema and an evaluator. Invariants the next editor must preserve:
//   1. Assertions are pure functions of step results plus a small set of host
//      reads through Env. They must never spawn processes or perform network
//      calls. New side-effecting kinds belong in a new step kind not here.
//   2. The orchestrator runs every assertion regardless of prior assertion
//      results. ok in the envelope is the AND of all assertion ok values.
//   3. detail is the human-readable explanation. It must be safe to log.
//      Do not include secrets. Do not include full file contents.

export interface AssertionContext {
  env: Env;
  workDir: string;
  stepResults: BankaiStepResult[];
}

export interface AssertionHandler<S extends z.ZodTypeAny> {
  kind: string;
  schema: S;
  evaluate(
    spec: z.infer<S>,
    ctx: AssertionContext,
  ): Promise<Omit<BankaiAssertionResult, "id" | "kind">>;
}

type AnyAssertionHandler = AssertionHandler<z.ZodTypeAny>;

const registry = new Map<string, AnyAssertionHandler>();

export function registerAssertion<S extends z.ZodTypeAny>(handler: AssertionHandler<S>): void {
  if (registry.has(handler.kind)) {
    throw new Error(`assertion kind already registered: ${handler.kind}`);
  }
  registry.set(handler.kind, handler as AnyAssertionHandler);
}

export function getAssertionHandler(kind: string): AnyAssertionHandler {
  const handler = registry.get(kind);
  if (!handler) {
    throw new Error(`unknown assertion kind: ${kind}`);
  }
  return handler;
}

export function listRegisteredAssertionKinds(): string[] {
  return [...registry.keys()].sort();
}
