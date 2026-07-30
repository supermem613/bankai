import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createNodeEnv, type Env } from "../env-runtime/env.js";
import { createRunLogger, defaultBankaiLogsDir } from "../log/jsonl.js";
import { resolveShellCommand, type ShellStepV1 } from "../steps/shell.js";
import type { BankaiEnvelope, BankaiStepResult } from "../plan/envelope.js";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
}

type RunCommand = (command: string, args: string[], cwd: string, env: Env) => Promise<CommandResult>;

export interface UpdateCommandOptions {
  env?: Env;
  repoRoot?: string;
  logDir?: string;
  logFile?: string;
  isGitRepo?: (repoRoot: string) => Promise<boolean>;
  runCommand?: RunCommand;
}

interface SodaEnvelope<TData> {
  ok?: boolean;
  data?: TData;
  error?: string;
}

interface SodaPullOutcome {
  status?: string;
  worktreeUpdated?: boolean;
}

export function gitPullMadeNoChanges(output: string): boolean {
  return /already up[- ]to[- ]date\.?/i.test(output);
}

export async function runUpdateCommand(opts: UpdateCommandOptions = {}): Promise<BankaiEnvelope> {
  const env = opts.env ?? createNodeEnv();
  const repoRoot = opts.repoRoot ?? dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const startedAt = env.clock.isoNow();
  const startedNow = env.clock.now();
  const logger = createRunLogger({
    env,
    command: "update",
    logsDir: opts.logDir ?? defaultBankaiLogsDir(env),
    logFile: opts.logFile,
  });
  const runCommand = opts.runCommand ?? defaultRunCommand;
  const isGitRepo = opts.isGitRepo ?? defaultIsGitRepo;
  const steps: BankaiStepResult[] = [];

  logger.emit("update.start", { repoRoot });

  if (!await isGitRepo(repoRoot)) {
    const finishedAt = env.clock.isoNow();
    const envelope: BankaiEnvelope = {
      ok: false,
      command: "update",
      startedAt,
      finishedAt,
      durationMs: env.clock.now() - startedNow,
      runId: logger.runId,
      logFile: logger.logFilePath,
      steps,
      failure: {
        stage: "validation",
        reason: `Bankai install directory is not a git repository: ${repoRoot}`,
      },
    };
    logger.emit("update.end", { ok: false, reason: envelope.failure?.reason });
    await logger.close();
    return envelope;
  }

  const sodaManaged = await isSodaManagedRepo(repoRoot, runCommand, env);
  const pullStep = await (sodaManaged
    ? runSodaPullStep({ cwd: repoRoot, env, logger, runCommand })
    : runGitPullStep({ cwd: repoRoot, env, logger, runCommand }));
  steps.push(pullStep.step);
  if (!pullStep.step.ok) {
    return await finishUpdate({ env, logger, startedAt, startedNow, steps, failureReason: pullStep.step.error ?? "pull failed" });
  }

  if (!pullStep.worktreeChanged) {
    logger.emit("update.skip", { reason: "already up to date" });
    return await finishUpdate({ env, logger, startedAt, startedNow, steps });
  }

  const installStep = await runUpdateStep({
    id: "npm-install",
    command: "npm",
    args: ["install", "--no-audit", "--no-fund"],
    cwd: repoRoot,
    env,
    logger,
    runCommand,
  });
  steps.push(installStep.step);
  if (!installStep.step.ok) {
    return await finishUpdate({ env, logger, startedAt, startedNow, steps, failureReason: installStep.step.error ?? "npm install failed" });
  }

  const buildStep = await runUpdateStep({
    id: "npm-build",
    command: "npm",
    args: ["run", "build"],
    cwd: repoRoot,
    env,
    logger,
    runCommand,
  });
  steps.push(buildStep.step);
  if (!buildStep.step.ok) {
    return await finishUpdate({ env, logger, startedAt, startedNow, steps, failureReason: buildStep.step.error ?? "npm run build failed" });
  }

  return await finishUpdate({ env, logger, startedAt, startedNow, steps });
}

async function runGitPullStep(opts: {
  cwd: string;
  env: Env;
  logger: ReturnType<typeof createRunLogger>;
  runCommand: RunCommand;
}): Promise<{ step: BankaiStepResult; result: CommandResult; worktreeChanged: boolean }> {
  const gitStep = await runUpdateStep({
    id: "git-pull",
    command: "git",
    args: ["pull", "--ff-only"],
    cwd: opts.cwd,
    env: opts.env,
    logger: opts.logger,
    runCommand: opts.runCommand,
  });
  const gitOutput = `${gitStep.result.stdout}\n${gitStep.result.stderr}`;
  return {
    ...gitStep,
    worktreeChanged: gitStep.step.ok && !gitPullMadeNoChanges(gitOutput),
  };
}

async function runSodaPullStep(opts: {
  cwd: string;
  env: Env;
  logger: ReturnType<typeof createRunLogger>;
  runCommand: RunCommand;
}): Promise<{ step: BankaiStepResult; result: CommandResult; worktreeChanged: boolean }> {
  const sodaStep = await runUpdateStep({
    id: "sd-pull",
    command: "sd",
    args: ["pull"],
    cwd: opts.cwd,
    env: opts.env,
    logger: opts.logger,
    runCommand: opts.runCommand,
    validateResult: validateSodaPullResult,
  });
  if (!sodaStep.step.ok) {
    return { ...sodaStep, worktreeChanged: false };
  }
  const envelope = parseSodaEnvelope<SodaPullOutcome[]>(sodaStep.result.stdout);
  return {
    ...sodaStep,
    worktreeChanged: Array.isArray(envelope?.data) && envelope.data.some((outcome) => outcome.worktreeUpdated === true),
  };
}

async function runUpdateStep(opts: {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  env: Env;
  logger: ReturnType<typeof createRunLogger>;
  runCommand: RunCommand;
  validateResult?: (result: CommandResult) => { ok: boolean; error?: string };
}): Promise<{ step: BankaiStepResult; result: CommandResult }> {
  const startedAt = opts.env.clock.isoNow();
  const startedNow = opts.env.clock.now();
  opts.logger.emit("update.step.start", { stepId: opts.id, command: opts.command, args: opts.args, cwd: opts.cwd });
  const result = await opts.runCommand(opts.command, opts.args, opts.cwd, opts.env);
  const validation = opts.validateResult?.(result);
  const ok = validation?.ok ?? result.exitCode === 0;
  const finishedAt = opts.env.clock.isoNow();
  const step: BankaiStepResult = {
    id: opts.id,
    kind: "shell",
    ok,
    startedAt,
    finishedAt,
    durationMs: opts.env.clock.now() - startedNow,
    error: ok ? undefined : validation?.error ?? `${opts.command} ${opts.args.join(" ")} exited with code ${result.exitCode}`,
    shell: {
      exitCode: result.exitCode,
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
      stdoutTail: tail(result.stdout),
      stderrTail: tail(result.stderr),
    },
  };
  opts.logger.emit("update.step.end", { stepId: opts.id, ok, exitCode: result.exitCode });
  return { step, result };
}

async function finishUpdate(opts: {
  env: Env;
  logger: ReturnType<typeof createRunLogger>;
  startedAt: string;
  startedNow: number;
  steps: BankaiStepResult[];
  failureReason?: string;
}): Promise<BankaiEnvelope> {
  const finishedAt = opts.env.clock.isoNow();
  const ok = opts.failureReason === undefined;
  const failureReason = opts.failureReason;
  const envelope: BankaiEnvelope = {
    ok,
    command: "update",
    startedAt: opts.startedAt,
    finishedAt,
    durationMs: opts.env.clock.now() - opts.startedNow,
    runId: opts.logger.runId,
    logFile: opts.logger.logFilePath,
    steps: opts.steps,
    failure: failureReason === undefined ? undefined : {
      stage: "step",
      reason: failureReason,
    },
  };
  opts.logger.emit("update.end", { ok, totalSteps: opts.steps.length });
  await opts.logger.close();
  return envelope;
}

async function defaultIsGitRepo(repoRoot: string): Promise<boolean> {
  return existsSync(`${repoRoot}/.git`) || existsSync(`${repoRoot}\\.git`);
}

// soda's git-interlock hooks block raw git writes in an sd-powered repo, and
// soda tracks stream state a raw `git pull` bypasses, so a soda-managed
// checkout must self-update through `sd`. `initialized: true` is the
// authoritative signal: a plain git repo that `sd` can merely read reports
// false, and anything that cannot answer stays on git. `sd` is an npm bin shim
// on Windows, and defaultRunCommand's resolveCommand already wraps .cmd targets
// in ComSpec, so no extra spawn handling is needed here.
async function isSodaManagedRepo(repoRoot: string, runCommand: RunCommand, env: Env): Promise<boolean> {
  try {
    const result = await runCommand("sd", ["status"], repoRoot, env);
    if (result.exitCode !== 0) {
      return false;
    }
    const envelope = parseSodaEnvelope<{ summary?: { initialized?: boolean } }>(result.stdout);
    return envelope?.ok === true && envelope.data?.summary?.initialized === true;
  } catch {
    return false;
  }
}

function parseSodaEnvelope<TData>(stdout: string): SodaEnvelope<TData> | undefined {
  try {
    return JSON.parse(stdout) as SodaEnvelope<TData>;
  } catch {
    return undefined;
  }
}

function validateSodaPullResult(result: CommandResult): { ok: boolean; error?: string } {
  const envelope = parseSodaEnvelope<SodaPullOutcome[]>(result.stdout);
  if (result.exitCode !== 0) {
    return { ok: false, error: `sd pull failed: ${envelope?.error ?? nonEmpty(result.stderr, result.stdout) ?? `exit code ${result.exitCode}`}` };
  }
  if (!envelope) {
    return { ok: false, error: "sd pull failed: unparseable sd pull output" };
  }
  if (envelope.ok !== true) {
    return { ok: false, error: `sd pull failed: ${envelope.error ?? "unknown error"}` };
  }
  if (!Array.isArray(envelope.data)) {
    return { ok: false, error: "sd pull failed: missing pull outcomes" };
  }
  return { ok: true };
}

function nonEmpty(...values: string[]): string | undefined {
  return values.map((value) => value.trim()).find((value) => value.length > 0);
}

async function defaultRunCommand(command: string, args: string[], cwd: string, env: Env): Promise<CommandResult> {
  const spec: ShellStepV1 = {
    kind: "shell",
    id: "update",
    command,
    args,
    resolveCommand: true,
    timeoutMs: 120_000,
    expectExitCode: 0,
    retries: 0,
    maxBufferBytes: 1_048_576,
  };
  const resolved = resolveShellCommand(spec, env);
  return await new Promise((resolve) => {
    const child = spawn(resolved.command, resolved.args, {
      cwd,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: resolved.windowsVerbatimArguments,
      env: env.env as NodeJS.ProcessEnv,
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      const message = err.message + "\n";
      resolve({ exitCode: -1, stdout, stderr: stderr + message, stdoutBytes, stderrBytes: stderrBytes + Buffer.byteLength(message) });
    });
    child.on("exit", (code) => {
      resolve({ exitCode: code ?? -1, stdout, stderr, stdoutBytes, stderrBytes });
    });
  });
}

function tail(value: string): string {
  return value.length > 4096 ? value.slice(value.length - 4096) : value;
}
