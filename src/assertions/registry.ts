import { z } from "zod";
import type { Env } from "../env-runtime/env.js";
import type { StepRunResult } from "../steps/registry.js";
import type { ResolvedBindings } from "../bindings.js";

// AssertionHandler registry: closed set of assertion kinds, each owns
// its zod schema and an evaluator. Invariants the next editor must
// preserve:
//   1. Assertions are pure functions of step results plus a small set
//      of host reads through Env. They must never spawn processes or
//      perform network calls. New side-effecting kinds belong in a
//      new step kind not here.
//   2. ctx.priorResults is a Map keyed by step id. The orchestrator
//      adds each step result as it completes so an assertion can read
//      any step's outcome that ran before it.
//   3. detail is the human-readable explanation. It must be safe to
//      log. Do not include secrets. Do not include full file contents.

export interface AssertionContext {
  env: Env;
  workDir: string;
  bindings: ResolvedBindings;
  priorResults: Map<string, StepRunResult>;
}

export interface AssertionOutcome {
  ok: boolean;
  detail: string;
}

export interface AssertionHandler<S extends z.ZodTypeAny> {
  kind: string;
  schema: S;
  evaluate(spec: z.infer<S>, ctx: AssertionContext): Promise<AssertionOutcome>;
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
