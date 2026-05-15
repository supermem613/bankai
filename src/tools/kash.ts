import { z } from "zod";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, delimiter, dirname } from "node:path";
import { resolve as resolvePath, isAbsolute as isAbsolutePath } from "node:path";
import { registerTool, type ToolContext, type ToolInvocationResult, type CheckResult } from "./registry.js";
import type { Env } from "../env-runtime/env.js";

// kash tool plugin: deterministic invocation of the kash CLI from a tool step.
// All tactical knowledge that previously lived in the legacy test-cli.mjs and
// in skill markdown lives here: how to find kash on PATH, how to translate a
// Windows .cmd shim into a node + js entrypoint pair so we never need
// shell:true, how many retries to attempt, whether to call `kash refresh`
// between failed attempts. Skill text MUST NOT need to know any of this.
//
// Invariants the next editor must preserve:
//   1. Discovery never depends on process.* or os.* directly. PATH and PATHEXT
//      come from ctx.env.env. Platform comes from ctx.env.platform. The host
//      node binary we spawn comes from ctx.env.exec. This keeps the plugin
//      sandbox-testable.
//   2. Retries are bounded by config.retries and the step-level timeout. A
//      retry storm cannot exceed step.timeoutMs because the abort signal from
//      the tool step closes every spawn the plugin owns.
//   3. `kash refresh` failures are non-fatal between attempts. The legacy
//      script does this on purpose because refresh sometimes spuriously fails
//      while the next prompt attempt succeeds.
//   4. config.binary, when set, BYPASSES discovery. Tests use this to inject
//      a stand-in via process.execPath plus a bundled JS file. End users
//      typically leave both binary and baseArgs unset.
//   5. doctor returns a CheckResult per probe so `bankai env doctor` can show
//      a concrete remediation hint. Never throws.

export const KashConfigSchema = z.object({
  binary: z.string().optional(),
  baseArgs: z.array(z.string()).default([]),
  retries: z.number().int().min(0).max(5).default(1),
  refreshOnRetry: z.boolean().default(true),
  attemptTimeoutMs: z.number().int().positive().default(60_000),
  refreshTimeoutMs: z.number().int().positive().default(30_000),
});

export const KashInvocationSchema = z.object({
  promptFile: z.string().min(1),
  outFile: z.string().min(1),
  subcommand: z.string().default("prompt"),
});

export type KashConfig = z.infer<typeof KashConfigSchema>;
export type KashInvocation = z.infer<typeof KashInvocationSchema>;

interface ResolvedEntrypoint {
  binary: string;
  baseArgs: string[];
  detail: string;
}

// Exported for unit testing. Walks PATH directories from the injected env
// snapshot and returns the first match including PATHEXT extensions on
// Windows. Pure function over the env arg.
export function findOnPath(env: Env, binaryName: string): string | undefined {
  const pathVar = env.env.PATH ?? env.env.Path ?? "";
  const dirs = pathVar.split(delimiter).filter((d) => d.length > 0);
  const exts = env.platform === "win32"
    ? (env.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase())
    : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, binaryName + ext);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

// Exported for unit testing. Given an env snapshot, returns the spawn target
// that runs kash without needing a shell. On Windows this typically resolves
// the kash.cmd shim to its node_modules/kash/dist/cli.js so we can spawn
// `node cli.js` directly. Falls back to spawning the discovered binary as-is.
export function discoverKashEntrypoint(env: Env): ResolvedEntrypoint | undefined {
  const direct = findOnPath(env, "kash");
  if (!direct) {
    return undefined;
  }
  if (env.platform === "win32" && direct.toLowerCase().endsWith(".cmd")) {
    const linkedJs = join(dirname(direct), "node_modules", "kash", "dist", "cli.js");
    if (existsSync(linkedJs)) {
      return {
        binary: env.exec,
        baseArgs: [linkedJs],
        detail: `${env.exec} ${linkedJs}`,
      };
    }
  }
  return { binary: direct, baseArgs: [], detail: direct };
}

interface SpawnOutcome {
  ok: boolean;
  exitCode?: number;
  stdout: string;
  stderr: string;
  error?: string;
}

async function spawnAndCapture(args: {
  binary: string;
  argv: string[];
  cwd: string;
  env: Env;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (out: SpawnOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(out);
    };

    const child = spawn(args.binary, args.argv, {
      cwd: args.cwd,
      env: args.env.env as NodeJS.ProcessEnv,
      shell: false,
      windowsHide: true,
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString("utf8");
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString("utf8");
      });
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({
        ok: false,
        stdout: stdoutBuf,
        stderr: stderrBuf,
        error: `attempt timed out after ${args.timeoutMs}ms`,
      });
    }, args.timeoutMs);

    const onAbort = (): void => {
      child.kill("SIGKILL");
      const reason = args.signal.reason instanceof Error
        ? args.signal.reason.message
        : "aborted";
      settle({ ok: false, stdout: stdoutBuf, stderr: stderrBuf, error: reason });
    };
    if (args.signal.aborted) {
      onAbort();
      clearTimeout(timer);
      return;
    }
    args.signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      clearTimeout(timer);
      args.signal.removeEventListener("abort", onAbort);
      settle({ ok: false, stdout: stdoutBuf, stderr: stderrBuf, error: err.message });
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      args.signal.removeEventListener("abort", onAbort);
      const exitCode = code ?? -1;
      settle({
        ok: exitCode === 0,
        exitCode,
        stdout: stdoutBuf,
        stderr: stderrBuf,
        error: exitCode === 0 ? undefined : `exited with code ${exitCode}`,
      });
    });
  });
}

interface ResolvedSpawnTarget {
  binary: string;
  baseArgs: string[];
}

function resolveSpawnTarget(
  env: Env,
  config: KashConfig,
): ResolvedSpawnTarget | undefined {
  if (config.binary) {
    return { binary: config.binary, baseArgs: config.baseArgs };
  }
  const ep = discoverKashEntrypoint(env);
  if (!ep) {
    return undefined;
  }
  return { binary: ep.binary, baseArgs: [...ep.baseArgs, ...config.baseArgs] };
}

async function invokeKash(
  ctx: ToolContext,
  config: KashConfig,
  invocation: KashInvocation,
): Promise<ToolInvocationResult> {
  const start = ctx.env.clock.now();
  const target = resolveSpawnTarget(ctx.env, config);
  if (!target) {
    return {
      ok: false,
      durationMs: ctx.env.clock.now() - start,
      stdout: "",
      stderr: "",
      error: "kash entrypoint not found on PATH. Install kash or set config.binary.",
    };
  }

  const absPrompt = isAbsolutePath(invocation.promptFile)
    ? invocation.promptFile
    : resolvePath(ctx.workDir, invocation.promptFile);
  const absOut = isAbsolutePath(invocation.outFile)
    ? invocation.outFile
    : resolvePath(ctx.workDir, invocation.outFile);

  const promptArgv = [
    ...target.baseArgs,
    invocation.subcommand,
    "--prompt-file",
    absPrompt,
    "--out",
    absOut,
  ];
  const refreshArgv = [...target.baseArgs, "refresh"];

  let lastOutcome: SpawnOutcome | undefined;
  const totalAttempts = config.retries + 1;
  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    if (ctx.signal.aborted) {
      break;
    }
    lastOutcome = await spawnAndCapture({
      binary: target.binary,
      argv: promptArgv,
      cwd: ctx.workDir,
      env: ctx.env,
      timeoutMs: config.attemptTimeoutMs,
      signal: ctx.signal,
    });
    if (lastOutcome.ok) {
      return {
        ok: true,
        durationMs: ctx.env.clock.now() - start,
        exitCode: lastOutcome.exitCode,
        stdout: lastOutcome.stdout,
        stderr: lastOutcome.stderr,
      };
    }
    if (attempt < totalAttempts && config.refreshOnRetry && !ctx.signal.aborted) {
      // Refresh failures are non-fatal. We log and continue to the next attempt.
      const refreshOutcome = await spawnAndCapture({
        binary: target.binary,
        argv: refreshArgv,
        cwd: ctx.workDir,
        env: ctx.env,
        timeoutMs: config.refreshTimeoutMs,
        signal: ctx.signal,
      });
      if (!refreshOutcome.ok) {
        ctx.env.logger.warn(
          `kash refresh failed between attempts (non-fatal): ${refreshOutcome.error ?? "unknown"}`,
        );
      }
    }
  }

  return {
    ok: false,
    durationMs: ctx.env.clock.now() - start,
    exitCode: lastOutcome?.exitCode,
    stdout: lastOutcome?.stdout ?? "",
    stderr: lastOutcome?.stderr ?? "",
    error: `kash failed after ${totalAttempts} attempt(s): ${lastOutcome?.error ?? "unknown"}`,
  };
}

async function doctorKash(env: Env, config: KashConfig): Promise<CheckResult[]> {
  if (config.binary) {
    const ok = existsSync(config.binary);
    return [
      {
        name: "kash-binary-explicit",
        ok,
        detail: config.binary,
        hint: ok ? undefined : "Configured config.binary path does not exist on disk.",
      },
    ];
  }
  const ep = discoverKashEntrypoint(env);
  return [
    {
      name: "kash-entrypoint",
      ok: !!ep,
      detail: ep ? ep.detail : "kash not found on PATH",
      hint: ep
        ? undefined
        : "Install kash and ensure `kash` resolves on PATH. On Windows, `cd ~/repos/kash && npm link` typically works.",
    },
  ];
}

registerTool({
  kind: "kash",
  configSchema: KashConfigSchema,
  invocationSchema: KashInvocationSchema,
  doctor: doctorKash,
  invoke: invokeKash,
});
