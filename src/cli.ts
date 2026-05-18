#!/usr/bin/env node

import { Command, Option } from "commander";
import { existsSync, readFileSync, watch } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

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
import { getStatusRegistryEntries, runStatusCommand } from "./commands/status.js";
import { runLogsCommand } from "./commands/logs.js";
import { runStopCommand } from "./commands/stop.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { runUpdateCommand } from "./commands/update.js";
import { emitEnvelope } from "./commands/format.js";
import { normalizeSchemaKind, schemaDocument } from "./commands/schema.js";
import { createNodeEnv } from "./env-runtime/env.js";
import { loadPlan } from "./plan/load.js";
import { defaultBankaiLogsDir, resolveLogFilePath } from "./log/jsonl.js";
import { launchVisibleTerminal } from "./visible-terminal.js";
import { createRegistryStore } from "./registry/store.js";

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const VERSION = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string }).version;
const VISIBLE_READY_TIMEOUT_MS = 10 * 60 * 1000;

const program = new Command();

async function visibleTerminalPlanInfo(planPath: string): Promise<{ needsVisibleTerminal: boolean; planName?: string; registerAs?: string }> {
  const loaded = await loadPlan({ env: createNodeEnv(), planPath });
  if (!loaded.ok) {
    return { needsVisibleTerminal: false };
  }
  let registerAs: string | undefined;
  const needsVisibleTerminal = loaded.plan.steps.some((step) => {
    const attached = step as { kind: string; requireVisibleTerminal?: unknown; registerAs?: unknown };
    if (attached.kind === "attached-process" && typeof attached.registerAs === "string" && !registerAs) {
      registerAs = attached.registerAs;
    }
    return attached.kind === "attached-process" && attached.requireVisibleTerminal !== false;
  });
  return { needsVisibleTerminal, planName: loaded.plan.name, registerAs };
}

async function waitForVisibleReadyEvent(path: string, timeoutMs: number): Promise<{ ok: boolean; detail: unknown }> {
  if (existsSync(path)) {
    const raw = await readFile(path, "utf8");
    const detail = JSON.parse(raw) as { ok?: boolean };
    return { ok: detail.ok !== false, detail };
  }
  await mkdir(dirname(path), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const dir = dirname(path);
    const watcher = watch(dir, () => {
      if (existsSync(path)) {
        clearTimeout(timer);
        watcher.close();
        resolve();
      }
    });
    const timer = setTimeout(() => {
      watcher.close();
      reject(new Error(`visible terminal did not report readiness after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  const raw = await readFile(path, "utf8");
  const detail = JSON.parse(raw) as { ok?: boolean };
  return { ok: detail.ok !== false, detail };
}

program
  .name("bankai")
  .description("Agentic-first orchestration engine for reliable dev-loop, test, and tool workflows")
  .version(VERSION);

program
  .command("run <plan>")
  .description("Execute a plan to completion")
  .option("--log-dir <path>", "directory to write the JSONL run log into")
  .option("--log-file <path>", "explicit log file path")
  .option("--bindings-file <path>", "JSON array of {key,value} bindings")
  .option("--bindings-json <json>", "inline JSON array of {key,value} bindings")
  .addOption(new Option("--visible-attached-terminal", "internal: attached-process already owns a visible terminal window").hideHelp())
  .option("--json", "deprecated no-op; JSON is always emitted")
  .option("--out <path>", "also write the envelope JSON to this path")
  .action(async (planPath: string, opts: Record<string, unknown>) => {
    const visibleInfo = await visibleTerminalPlanInfo(planPath);
    const env = createNodeEnv();
    if (opts.visibleAttachedTerminal !== true && visibleInfo.needsVisibleTerminal) {
      const startedAt = new Date().toISOString();
      const logsDir = typeof opts.logDir === "string" ? opts.logDir : defaultBankaiLogsDir(env);
      const logFile = typeof opts.logFile === "string"
        ? resolve(env.cwd, opts.logFile)
        : resolveLogFilePath({ env, command: "run", logsDir, planName: visibleInfo.planName });
      const readyEventFile = `${logFile}.ready.json`;
      await mkdir(dirname(readyEventFile), { recursive: true });
      await rm(readyEventFile, { force: true });
      const launch = process.platform === "win32"
        ? launchVisibleTerminal({
          cwd: process.cwd(),
          execPath: process.execPath,
          cliPath: fileURLToPath(import.meta.url),
          planPath,
          logFile,
          transcriptFile: `${logFile}.terminal.txt`,
          pathEnv: env.env.PATH ?? env.env.Path,
          pathext: env.env.PATHEXT,
          logDir: opts.logDir as string | undefined,
          bindingsFile: opts.bindingsFile as string | undefined,
          bindingsJson: opts.bindingsJson as string | undefined,
          out: opts.out as string | undefined,
        })
        : { launched: false, logFile, transcriptFile: `${logFile}.terminal.txt` };
      if (launch.launched && launch.pid && visibleInfo.registerAs) {
        await createRegistryStore({ env }).putEntry({
          pid: launch.pid,
          command: process.execPath,
          args: [fileURLToPath(import.meta.url), "run", planPath, "--visible-attached-terminal", "--log-file", logFile],
          workDir: process.cwd(),
          envKind: "visible-terminal-launch",
          logFile: launch.logFile,
          logStartOffset: 0,
          name: visibleInfo.registerAs,
          planName: visibleInfo.planName ?? "unknown",
          planPath,
          cwd: process.cwd(),
          registeredAt: env.clock.isoNow(),
          evidence: {
            transcriptFile: launch.transcriptFile,
            detail: "visible terminal launch record. The child attached-process runner replaces this entry after it starts.",
          },
        });
      }
      let ready: { ok: boolean; detail: unknown } | undefined;
      let waitFailure: Error | undefined;
      if (launch.launched) {
        try {
          ready = await waitForVisibleReadyEvent(readyEventFile, VISIBLE_READY_TIMEOUT_MS);
        } catch (err) {
          waitFailure = err instanceof Error ? err : new Error(String(err));
        }
      }
      const finishedAt = new Date().toISOString();
      const registry = visibleInfo.registerAs
        ? await getStatusRegistryEntries({ env, names: [visibleInfo.registerAs] })
        : undefined;
      const envelope = {
        ok: launch.launched && ready?.ok === true && !waitFailure,
        command: "run",
        startedAt,
        finishedAt,
        durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
        runId: "visible-terminal",
        logFile: launch.logFile,
        planPath,
        steps: [],
        registry,
        visibleTerminal: {
          launched: launch.launched,
          transcriptFile: launch.transcriptFile,
          detail: launch.launched
            ? "attached-process plan launched in a visible terminal window and reported readiness"
            : "attached-process plans require a visible terminal on this platform",
          readyEventFile,
          ready: ready?.detail,
        },
        failure: launch.launched && ready?.ok === true && !waitFailure ? undefined : {
          stage: launch.launched ? "step" : "validation",
          reason: waitFailure?.message ?? (ready?.ok === false ? "attached-process plan reported failure before readiness" : "attached-process plans require a visible terminal"),
          detail: ready?.detail,
        },
      };
      process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
      process.exit(envelope.ok ? 0 : 1);
    }
    const ac = new AbortController();
    const onSigint = (): void => {
      ac.abort(new Error("Ctrl+C requested"));
    };
    process.once("SIGINT", onSigint);
    let envelope;
    try {
      envelope = await runRunCommand({
        planPath,
        logDir: opts.logDir as string | undefined,
        logFile: opts.logFile as string | undefined,
        bindingsFile: opts.bindingsFile as string | undefined,
        bindingsJson: opts.bindingsJson as string | undefined,
        visibleAttachedTerminal: opts.visibleAttachedTerminal === true,
        signal: ac.signal,
      });
    } finally {
      process.removeListener("SIGINT", onSigint);
    }
    emitEnvelope(opts as { json?: boolean; out?: string }, envelope);
    process.exit(envelope.ok ? 0 : 1);
  });

program
  .command("status [name]")
  .description("Read the per-user shared registry. No plan needed.")
  .option("--log-dir <path>", "directory to write the JSONL run log into")
  .option("--log-file <path>", "explicit log file path")
  .option("--json", "deprecated no-op; JSON is always emitted")
  .option("--out <path>", "also write the envelope JSON to this path")
  .action(async (name: string | undefined, opts: Record<string, unknown>) => {
    const envelope = await runStatusCommand({
      name,
      logDir: opts.logDir as string | undefined,
      logFile: opts.logFile as string | undefined,
    });
    emitEnvelope(opts as { json?: boolean; out?: string }, envelope);
    process.exit(envelope.ok ? 0 : 1);
  });

program
  .command("logs [name]")
  .description("Read detailed logs for registered handles")
  .option("--log-dir <path>", "directory to write the JSONL run log into")
  .option("--log-file <path>", "explicit log file path")
  .option("--json", "deprecated no-op; JSON is always emitted")
  .option("--out <path>", "also write the envelope JSON to this path")
  .action(async (name: string | undefined, opts: Record<string, unknown>) => {
    const envelope = await runLogsCommand({
      name,
      logDir: opts.logDir as string | undefined,
      logFile: opts.logFile as string | undefined,
    });
    emitEnvelope(opts as { json?: boolean; out?: string }, envelope);
    process.exit(envelope.ok ? 0 : 1);
  });

program
  .command("stop <name>")
  .description("Terminate a registered handle by name")
  .option("--force", "kill even if the fingerprint does not match")
  .option("--grace-ms <n>", "ms to wait between SIGTERM and SIGKILL", (v) => parseInt(v, 10))
  .option("--log-dir <path>", "directory to write the JSONL run log into")
  .option("--log-file <path>", "explicit log file path")
  .option("--json", "deprecated no-op; JSON is always emitted")
  .option("--out <path>", "also write the envelope JSON to this path")
  .action(async (name: string, opts: Record<string, unknown>) => {
    const envelope = await runStopCommand({
      name,
      force: opts.force === true,
      graceMs: opts.graceMs as number | undefined,
      logDir: opts.logDir as string | undefined,
      logFile: opts.logFile as string | undefined,
    });
    emitEnvelope(opts as { json?: boolean; out?: string }, envelope);
    process.exit(envelope.ok ? 0 : 1);
  });

program
  .command("doctor")
  .description("Health check: node version, plugin doctors, registry, lock, optional plan validation")
  .option("--plan <path>", "validate a plan file in addition to base checks")
  .option("--prune", "remove stale registry entries and stale lock files")
  .option("--log-dir <path>", "directory to write the JSONL run log into")
  .option("--log-file <path>", "explicit log file path")
  .option("--json", "deprecated no-op; JSON is always emitted")
  .option("--out <path>", "also write the envelope JSON to this path")
  .action(async (opts: Record<string, unknown>) => {
    const envelope = await runDoctorCommand({
      planPath: opts.plan as string | undefined,
      prune: opts.prune === true,
      logDir: opts.logDir as string | undefined,
      logFile: opts.logFile as string | undefined,
    });
    emitEnvelope(opts as { json?: boolean; out?: string }, envelope);
    process.exit(envelope.ok ? 0 : 1);
  });

program
  .command("update")
  .description("Self-update this Bankai git checkout")
  .option("--log-dir <path>", "directory to write the JSONL run log into")
  .option("--log-file <path>", "explicit log file path")
  .option("--json", "deprecated no-op; JSON is always emitted")
  .option("--out <path>", "also write the envelope JSON to this path")
  .action(async (opts: Record<string, unknown>) => {
    const envelope = await runUpdateCommand({
      logDir: opts.logDir as string | undefined,
      logFile: opts.logFile as string | undefined,
    });
    emitEnvelope(opts as { json?: boolean; out?: string }, envelope);
    process.exit(envelope.ok ? 0 : 1);
  });

program
  .command("schema [kind]")
  .description("Print the Bankai command schema, or explicit plan/bindings schemas")
  .addHelpText("after", "\n\nKinds:\n  commands   Bankai command surface (default)\n  plan       Bankai plan JSON shape\n  bindings   JSON array shape for --bindings-file and --bindings-json\n")
  .action((kind: string | undefined) => {
    const normalized = normalizeSchemaKind(kind);
    if (!normalized) {
      process.stderr.write(`unknown schema kind "${kind}". Expected "commands", "plan", or "bindings".\n`);
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(schemaDocument(normalized), null, 2) + "\n");
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
