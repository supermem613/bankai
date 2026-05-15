import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import chalk from "chalk";
import { createNodeEnv } from "../../env-runtime/env.js";
import { runScenario } from "../../orchestrators/test.js";
import type { BankaiTestEnvelope } from "../../schema/envelope.js";

export interface TestRunOptions {
  json?: boolean;
}

export async function testRunCommand(scenarioPath: string, opts: TestRunOptions): Promise<void> {
  const absolutePath = resolve(scenarioPath);
  let raw: string;
  try {
    raw = readFileSync(absolutePath, "utf8");
  } catch (err) {
    failHard(opts, {
      schemaVersion: "1",
      ok: false,
      scenario: scenarioPath,
      durationMs: 0,
      steps: [],
      assertions: [],
      failure: {
        stage: "validation",
        id: "scenario-file",
        reason: err instanceof Error ? err.message : String(err),
      },
    });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    failHard(opts, {
      schemaVersion: "1",
      ok: false,
      scenario: scenarioPath,
      durationMs: 0,
      steps: [],
      assertions: [],
      failure: {
        stage: "validation",
        id: "scenario-file",
        reason: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      },
    });
    return;
  }

  const env = createNodeEnv({ cwd: dirname(absolutePath) });
  const envelope = await runScenario({
    scenarioJson: parsed,
    env,
    workDir: dirname(absolutePath),
  });

  emit(opts, envelope);
}

function emit(opts: TestRunOptions, envelope: BankaiTestEnvelope): void {
  if (opts.json) {
    process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
    process.exit(envelope.ok ? 0 : 1);
  }

  process.stdout.write(chalk.bold(`bankai test run: ${envelope.scenario}\n\n`));
  for (const step of envelope.steps) {
    const icon = step.ok ? chalk.green("✓") : chalk.red("✗");
    const exit = step.exitCode !== undefined ? ` (exit ${step.exitCode})` : "";
    process.stdout.write(`  ${icon} step  ${step.id.padEnd(28, ".")} ${step.kind}${exit} ${step.durationMs}ms\n`);
    if (!step.ok && step.error) {
      process.stdout.write(`        ${chalk.dim(step.error)}\n`);
    }
  }
  for (const a of envelope.assertions) {
    const icon = a.ok ? chalk.green("✓") : chalk.red("✗");
    process.stdout.write(`  ${icon} check ${a.id.padEnd(28, ".")} ${a.kind}\n`);
    if (!a.ok) {
      process.stdout.write(`        ${chalk.dim(a.detail)}\n`);
    }
  }
  process.stdout.write("\n");
  if (envelope.ok) {
    process.stdout.write(chalk.green(`PASS  ${envelope.scenario}  ${envelope.durationMs}ms\n`));
    process.exit(0);
  }
  const f = envelope.failure;
  const reason = f ? `${f.stage} ${f.id}: ${f.reason}` : "unknown failure";
  process.stdout.write(chalk.red(`FAIL  ${envelope.scenario}  ${envelope.durationMs}ms\n`));
  process.stdout.write(chalk.red(`      ${reason}\n`));
  process.exit(1);
}

function failHard(opts: TestRunOptions, envelope: BankaiTestEnvelope): void {
  emit(opts, envelope);
}
