// BankaiTestEnvelope is the stable JSON contract emitted by `bankai test run`
// when --json is passed. Invariants the next editor must preserve:
//   1. schemaVersion is required and must match the producer code's version.
//      Consumers may refuse to parse if the version is unrecognized.
//   2. ok is a strict boolean. Present even when failure is set so a single
//      branch on envelope.ok suffices for callers.
//   3. failure.stage names which phase aborted the run. validation errors
//      come from schema parse. step errors come from a step handler. assertion
//      errors come from an assertion that returned ok=false.
//   4. step results carry exitCode separately from ok so a step that expected
//      a non-zero exit can be ok=true while exitCode is non-zero.

export interface BankaiStepResult {
  id: string;
  kind: string;
  ok: boolean;
  durationMs: number;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface BankaiAssertionResult {
  id: string;
  kind: string;
  ok: boolean;
  detail: string;
}

export interface BankaiTestFailure {
  stage: "validation" | "step" | "assertion";
  id: string;
  reason: string;
}

export interface BankaiTestEnvelope {
  schemaVersion: "1";
  ok: boolean;
  scenario: string;
  durationMs: number;
  steps: BankaiStepResult[];
  assertions: BankaiAssertionResult[];
  failure?: BankaiTestFailure;
}
