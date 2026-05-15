#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Side-effect imports register every built-in step kind, env plugin,
// tool plugin, assertion, and readiness probe. Import order matters
// only insofar as steps depend on the registries being populated when
// the orchestrator loads a plan. These five lines are the canonical
// bootstrap.
import "./steps/index.js";
import "./assertions/index.js";
import "./environments/index.js";
import "./tools/index.js";
import "./readiness/index.js";

import { runRunCommand } from "./commands/run.js";
import { runStatusCommand } from "./commands/status.js";
import { runStopCommand } from "./commands/stop.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { emitEnvelope } from "./commands/format.js";

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const VERSION = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string }).version;

const program = new Command();

program
  .name("bankai")
  .description("Generic CLI orchestrator for plan-driven workflows")
  .version(VERSION);

program
  .command("run <plan>")
  .description("Execute a plan to completion")
  .option("--log-dir <path>", "directory to write the JSONL run log into")
  .option("--log-file <path>", "explicit log file path")
  .option("--repo-root <path>", "override the repo root used to locate .bankai/logs")
  .option("--json", "emit machine-readable envelope JSON")
  .option("--pretty", "emit a brief human summary")
  .option("--out <path>", "also write the envelope JSON to this path")
  .action(async (planPath: string, opts: Record<string, unknown>) => {
    const envelope = await runRunCommand({
      planPath,
      logDir: opts.logDir as string | undefined,
      logFile: opts.logFile as string | undefined,
      repoRoot: opts.repoRoot as string | undefined,
    });
    emitEnvelope(opts as { json?: boolean; pretty?: boolean; out?: string }, envelope);
    process.exit(envelope.ok ? 0 : 1);
  });

program
  .command("status [name]")
  .description("Read the per-user shared registry. No plan needed.")
  .option("--log-dir <path>", "directory to write the JSONL run log into")
  .option("--log-file <path>", "explicit log file path")
  .option("--repo-root <path>", "override the repo root used to locate .bankai/logs")
  .option("--json", "emit machine-readable envelope JSON")
  .option("--pretty", "emit a brief human summary")
  .option("--out <path>", "also write the envelope JSON to this path")
  .action(async (name: string | undefined, opts: Record<string, unknown>) => {
    const envelope = await runStatusCommand({
      name,
      logDir: opts.logDir as string | undefined,
      logFile: opts.logFile as string | undefined,
      repoRoot: opts.repoRoot as string | undefined,
    });
    emitEnvelope(opts as { json?: boolean; pretty?: boolean; out?: string }, envelope);
    process.exit(envelope.ok ? 0 : 1);
  });

program
  .command("stop <name>")
  .description("Terminate a registered handle by name")
  .option("--force", "kill even if the fingerprint does not match")
  .option("--grace-ms <n>", "ms to wait between SIGTERM and SIGKILL", (v) => parseInt(v, 10))
  .option("--log-dir <path>", "directory to write the JSONL run log into")
  .option("--log-file <path>", "explicit log file path")
  .option("--repo-root <path>", "override the repo root used to locate .bankai/logs")
  .option("--json", "emit machine-readable envelope JSON")
  .option("--pretty", "emit a brief human summary")
  .option("--out <path>", "also write the envelope JSON to this path")
  .action(async (name: string, opts: Record<string, unknown>) => {
    const envelope = await runStopCommand({
      name,
      force: opts.force === true,
      graceMs: opts.graceMs as number | undefined,
      logDir: opts.logDir as string | undefined,
      logFile: opts.logFile as string | undefined,
      repoRoot: opts.repoRoot as string | undefined,
    });
    emitEnvelope(opts as { json?: boolean; pretty?: boolean; out?: string }, envelope);
    process.exit(envelope.ok ? 0 : 1);
  });

program
  .command("doctor")
  .description("Health check: node version, plugin doctors, registry, lock, optional plan validation")
  .option("--plan <path>", "validate a plan file in addition to base checks")
  .option("--prune", "remove stale registry entries and stale lock files")
  .option("--log-dir <path>", "directory to write the JSONL run log into")
  .option("--log-file <path>", "explicit log file path")
  .option("--repo-root <path>", "override the repo root used to locate .bankai/logs")
  .option("--json", "emit machine-readable envelope JSON")
  .option("--pretty", "emit a brief human summary")
  .option("--out <path>", "also write the envelope JSON to this path")
  .action(async (opts: Record<string, unknown>) => {
    const envelope = await runDoctorCommand({
      planPath: opts.plan as string | undefined,
      prune: opts.prune === true,
      logDir: opts.logDir as string | undefined,
      logFile: opts.logFile as string | undefined,
      repoRoot: opts.repoRoot as string | undefined,
    });
    emitEnvelope(opts as { json?: boolean; pretty?: boolean; out?: string }, envelope);
    process.exit(envelope.ok ? 0 : 1);
  });

if (process.argv.slice(2).length === 0) {
  process.stdout.write(`bankai v${VERSION}\n\n`);
  program.outputHelp();
  process.exit(0);
}

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
