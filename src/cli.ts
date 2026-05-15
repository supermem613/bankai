#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { doctorCommand } from "./commands/doctor.js";
import { testRunCommand } from "./commands/test/run.js";

// Read version from package.json so it stays in sync with the published version.
const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const VERSION = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string }).version;

const program = new Command();

program
  .name("bankai")
  .description("Reliable orchestration engine for dev-loop and test plan execution with environment plugins")
  .version(VERSION);

program
  .command("doctor")
  .description("Health check: verify environment and configuration")
  .option("--json", "Emit machine-readable JSON instead of human output")
  .action(doctorCommand);

const test = program.command("test").description("Plan-driven test scenario runner");
test
  .command("run <scenario>")
  .description("Run a scenario JSON file end-to-end and emit a structured envelope")
  .option("--json", "Emit machine-readable envelope JSON instead of human output")
  .action(testRunCommand);

// Bare `bankai` (no args) prints version + full help. Matches the
// rotunda/kash/reflux convention. No version banner before sub-commands
// so machine-parseable output stays clean.
if (process.argv.slice(2).length === 0) {
  process.stdout.write(`bankai v${VERSION}\n\n`);
  program.outputHelp();
  process.exit(0);
}

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
