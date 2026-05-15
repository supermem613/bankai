import { ScenarioV1Schema, type ScenarioV1 } from "../schema/scenario.js";
import type {
  BankaiTestEnvelope,
  BankaiStepResult,
  BankaiAssertionResult,
  BankaiTestFailure,
} from "../schema/envelope.js";
import { getStepHandler } from "../steps/_registry.js";
import { getAssertionHandler } from "../assertions/_registry.js";
import { getEnvironment } from "../environments/_registry.js";
import { createLifecycleScope } from "../environments/_lifecycle-scope.js";
import type { EnvironmentHandle } from "../environments/_interface.js";
import type { Env } from "../env-runtime/env.js";
import "../steps/index.js";
import "../assertions/index.js";
import "../environments/index.js";

// Test orchestrator: drives a single scenario from validated spec to envelope.
// Invariants the next editor must preserve:
//   1. Validation is two-pass. First the top-level schema parses the file.
//      Then every step and assertion spec is parsed by its handler schema.
//      Both must succeed before any step runs. This catches typos before
//      side effects start.
//   2. Steps run sequentially in spec order. A failed step aborts further
//      step execution. Assertions still run so failures can show what state
//      reached. ok in the envelope is the AND of all step ok and all
//      assertion ok values.
//   3. Duplicate ids within steps or assertions are rejected at validation.
//      Assertion stepId references must point at a real step id.
//   4. Environment lifecycle is bracketed around steps and assertions. setup
//      runs after preflight validation. teardown runs in a finally block so
//      it executes whether or not steps succeed. A partial setup throw
//      triggers scope.unwind so any resources acquired before the throw are
//      released even though no handle exists yet.

const DEFAULT_SETUP_TIMEOUT_MS = 30_000;

export interface RunScenarioOptions {
  scenarioJson: unknown;
  env: Env;
  workDir: string;
}

export async function runScenario(opts: RunScenarioOptions): Promise<BankaiTestEnvelope> {
  const start = opts.env.clock.now();

  const parseResult = ScenarioV1Schema.safeParse(opts.scenarioJson);
  if (!parseResult.success) {
    return {
      schemaVersion: "1",
      ok: false,
      scenario: "<unknown>",
      durationMs: opts.env.clock.now() - start,
      steps: [],
      assertions: [],
      failure: {
        stage: "validation",
        id: "scenario",
        reason: parseResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      },
    };
  }
  const scenario: ScenarioV1 = parseResult.data;

  const validationFailure = preflightValidate(scenario);
  if (validationFailure) {
    return {
      schemaVersion: "1",
      ok: false,
      scenario: scenario.name,
      durationMs: opts.env.clock.now() - start,
      steps: [],
      assertions: [],
      failure: validationFailure,
    };
  }

  const envRef = scenario.environment ?? { kind: "noop" };
  const envPlugin = getEnvironment(envRef.kind);
  if (!envPlugin) {
    return {
      schemaVersion: "1",
      ok: false,
      scenario: scenario.name,
      durationMs: opts.env.clock.now() - start,
      steps: [],
      assertions: [],
      failure: {
        stage: "validation",
        id: "environment",
        reason: `unknown environment kind: ${envRef.kind}`,
      },
    };
  }

  const configParse = envPlugin.configSchema.safeParse(envRef.config ?? {});
  if (!configParse.success) {
    return {
      schemaVersion: "1",
      ok: false,
      scenario: scenario.name,
      durationMs: opts.env.clock.now() - start,
      steps: [],
      assertions: [],
      failure: {
        stage: "validation",
        id: "environment",
        reason: configParse.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      },
    };
  }

  const scope = createLifecycleScope({
    onCleanupError: (err) => {
      opts.env.logger.warn(`env cleanup error: ${err instanceof Error ? err.message : String(err)}`);
    },
  });
  const timeoutMs = envRef.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS;
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => {
    abortController.abort(new Error(`environment setup exceeded ${timeoutMs}ms`));
  }, timeoutMs);

  let handle: EnvironmentHandle | undefined;
  try {
    handle = await envPlugin.setup(
      {
        env: opts.env,
        workDir: opts.workDir,
        scenarioName: scenario.name,
        scope,
        signal: abortController.signal,
        timeoutMs,
      },
      configParse.data,
    );
  } catch (err) {
    clearTimeout(timeoutHandle);
    await scope.unwind();
    return {
      schemaVersion: "1",
      ok: false,
      scenario: scenario.name,
      durationMs: opts.env.clock.now() - start,
      steps: [],
      assertions: [],
      failure: {
        stage: "env-setup",
        id: envRef.kind,
        reason: err instanceof Error ? err.message : String(err),
      },
    };
  }
  clearTimeout(timeoutHandle);

  const stepResults: BankaiStepResult[] = [];
  const assertionResults: BankaiAssertionResult[] = [];
  let stepFailure: BankaiTestFailure | undefined;
  let assertionFailure: BankaiTestFailure | undefined;
  let teardownFailure: BankaiTestFailure | undefined;

  try {
    for (const stepRef of scenario.steps) {
      const handler = getStepHandler(stepRef.kind);
      const spec = handler.schema.parse(stepRef);
      const result = await handler.run(spec, {
        env: opts.env,
        workDir: opts.workDir,
        scenarioName: scenario.name,
      });
      stepResults.push({ id: stepRef.id, kind: stepRef.kind, ...result });
      if (!result.ok) {
        stepFailure = {
          stage: "step",
          id: stepRef.id,
          reason: result.error ?? "step failed without a reason",
        };
        break;
      }
    }

    if (!stepFailure) {
      for (const assertionRef of scenario.assertions) {
        const handler = getAssertionHandler(assertionRef.kind);
        const spec = handler.schema.parse(assertionRef);
        const result = await handler.evaluate(spec, {
          env: opts.env,
          workDir: opts.workDir,
          stepResults,
        });
        assertionResults.push({ id: assertionRef.id, kind: assertionRef.kind, ...result });
        if (!result.ok && !assertionFailure) {
          assertionFailure = {
            stage: "assertion",
            id: assertionRef.id,
            reason: result.detail,
          };
        }
      }
    }
  } finally {
    try {
      await handle.teardown();
    } catch (err) {
      teardownFailure = {
        stage: "env-teardown",
        id: envRef.kind,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    await scope.unwind();
  }

  const failure = stepFailure ?? assertionFailure ?? teardownFailure;
  return {
    schemaVersion: "1",
    ok: !failure,
    scenario: scenario.name,
    durationMs: opts.env.clock.now() - start,
    steps: stepResults,
    assertions: assertionResults,
    failure,
  };
}

function preflightValidate(scenario: ScenarioV1): BankaiTestFailure | undefined {
  const seenStepIds = new Set<string>();
  for (const step of scenario.steps) {
    if (seenStepIds.has(step.id)) {
      return { stage: "validation", id: step.id, reason: `duplicate step id "${step.id}"` };
    }
    seenStepIds.add(step.id);
    try {
      const handler = getStepHandler(step.kind);
      const result = handler.schema.safeParse(step);
      if (!result.success) {
        return {
          stage: "validation",
          id: step.id,
          reason: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        };
      }
    } catch (err) {
      return {
        stage: "validation",
        id: step.id,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const seenAssertionIds = new Set<string>();
  for (const assertion of scenario.assertions) {
    if (seenAssertionIds.has(assertion.id)) {
      return {
        stage: "validation",
        id: assertion.id,
        reason: `duplicate assertion id "${assertion.id}"`,
      };
    }
    seenAssertionIds.add(assertion.id);
    try {
      const handler = getAssertionHandler(assertion.kind);
      const result = handler.schema.safeParse(assertion);
      if (!result.success) {
        return {
          stage: "validation",
          id: assertion.id,
          reason: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        };
      }
    } catch (err) {
      return {
        stage: "validation",
        id: assertion.id,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return undefined;
}

