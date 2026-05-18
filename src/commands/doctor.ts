import { unlink } from "node:fs/promises";
import { createNodeEnv, type Env } from "../env-runtime/env.js";
import { createRunLogger, defaultBankaiLogsDir } from "../log/jsonl.js";
import { resolveRepoRoot } from "../repo-root.js";
import { createRegistryStore } from "../registry/store.js";
import { isProcessAlive } from "../process-tree.js";
import { loadPlan } from "../plan/load.js";
import { listEnvironments, getEnvironment } from "../environments/registry.js";
import { listTools, getTool } from "../tools/registry.js";
import type { BankaiEnvelope } from "../plan/envelope.js";

// `bankai doctor [--plan <path>] [--prune]` — comprehensive health
// check. Always:
//   * Node version >= 24
//   * Bankai install integrity (steps registry populated)
//   * Per-env-plugin doctor()
//   * Per-tool-plugin doctor() with default config
//   * Stale registry scan; with --prune, remove dead entries
//   * Stale lock-file scan
// Optional:
//   * Plan validation (with --plan <path>)

export interface DoctorCommandOptions {
  planPath?: string;
  prune?: boolean;
  env?: Env;
  logDir?: string;
  logFile?: string;
  repoRoot?: string;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

const REQUIRED_NODE_MAJOR = 24;

export async function runDoctorCommand(opts: DoctorCommandOptions): Promise<BankaiEnvelope> {
  const env = opts.env ?? createNodeEnv();
  const repoRoot = resolveRepoRoot({ env, override: opts.repoRoot });
  const startedAt = env.clock.isoNow();
  const startedNow = env.clock.now();
  const logger = createRunLogger({
    env,
    command: "doctor",
    logsDir: opts.logDir ?? defaultBankaiLogsDir(env),
    logFile: opts.logFile,
  });
  logger.emit("doctor.start", { planPath: opts.planPath, prune: opts.prune, repoRoot });

  const checks: Check[] = [];

  // 1. Node version.
  const nodeMajor = parseInt(process.versions.node.split(".")[0]!, 10);
  checks.push({
    name: "node-version",
    ok: nodeMajor >= REQUIRED_NODE_MAJOR,
    detail: `node ${process.versions.node}`,
    hint: nodeMajor >= REQUIRED_NODE_MAJOR ? undefined : `bankai requires Node ${REQUIRED_NODE_MAJOR}+`,
  });

  // 2. Step kind registry populated.
  const { listRegisteredStepKinds } = await import("../steps/registry.js");
  const stepKinds = listRegisteredStepKinds();
  checks.push({
    name: "step-registry",
    ok: stepKinds.length >= 8,
    detail: `${stepKinds.length} step kinds registered: ${stepKinds.join(", ")}`,
    hint: stepKinds.length >= 8 ? undefined : "core step kinds missing; bankai install is corrupt",
  });

  // 3. Per-env-plugin doctor.
  for (const kind of listEnvironments()) {
    const plugin = getEnvironment(kind)!;
    try {
      const r = await plugin.doctor(env);
      for (const c of r) {
        checks.push({ ...c, name: `env:${kind}:${c.name}` });
      }
    } catch (err) {
      checks.push({
        name: `env:${kind}`,
        ok: false,
        detail: `doctor threw: ${(err as Error).message}`,
      });
    }
  }

  // 4. Per-tool-plugin doctor with empty config (each plugin's schema must default).
  for (const kind of listTools()) {
    const plugin = getTool(kind)!;
    try {
      const cfg = plugin.configSchema.parse({});
      const r = await plugin.doctor(env, cfg);
      for (const c of r) {
        checks.push({ ...c, name: `tool:${kind}:${c.name}` });
      }
    } catch (err) {
      checks.push({
        name: `tool:${kind}`,
        ok: false,
        detail: `doctor threw: ${(err as Error).message}`,
      });
    }
  }

  // 5. Registry stale scan (with optional prune).
  const store = createRegistryStore({ env });
  const file = await store.read();
  let pruned = 0;
  for (const entry of Object.values(file.entries)) {
    const alive = isProcessAlive(entry.pid);
    const willPrune = !alive && opts.prune === true;
    checks.push({
      name: `registry:${entry.name}`,
      ok: alive || willPrune,
      detail: `pid ${entry.pid} (${entry.envKind}) ${alive ? "alive" : willPrune ? "DEAD; removed by --prune" : "DEAD"}`,
      hint: alive || willPrune ? undefined : "rerun with --prune to clean up",
    });
    if (willPrune) {
      await store.removeEntry(entry.name);
      pruned += 1;
      logger.emit("registry.remove", { name: entry.name, pid: entry.pid, reason: "doctor.prune" });
    }
  }
  if (pruned > 0) {
    checks.push({ name: "registry-prune", ok: true, detail: `pruned ${pruned} stale entry(ies)` });
  }

  // 6. Stale lock scan.
  try {
    const { readFile, stat } = await import("node:fs/promises");
    let lockExists = true;
    let lockPid: number | undefined;
    let lockAgeMs = 0;
    try {
      const raw = await readFile(store.lockFilePath, "utf8");
      const s = await stat(store.lockFilePath);
      lockPid = parseInt(raw.trim(), 10);
      lockAgeMs = Date.now() - s.mtimeMs;
    } catch {
      lockExists = false;
    }
    if (!lockExists) {
      checks.push({ name: "registry-lock", ok: true, detail: "no lock file present" });
    } else {
      const lockAlive = lockPid && Number.isFinite(lockPid) ? isProcessAlive(lockPid) : false;
      const stale = !lockAlive;
      if (stale && opts.prune) {
        await unlink(store.lockFilePath);
        checks.push({ name: "registry-lock", ok: true, detail: `stale lock (pid ${lockPid}, age ${lockAgeMs}ms) removed by --prune` });
      } else {
        checks.push({
          name: "registry-lock",
          ok: !stale,
          detail: `lock held by pid ${lockPid} (age ${lockAgeMs}ms)${lockAlive ? " alive" : " DEAD"}`,
          hint: stale ? "stale lock; rerun with --prune to clean up" : undefined,
        });
      }
    }
  } catch (err) {
    checks.push({ name: "registry-lock", ok: false, detail: `lock scan failed: ${(err as Error).message}` });
  }

  // 7. Optional plan validation.
  if (opts.planPath) {
    const loaded = await loadPlan({ env, planPath: opts.planPath });
    if (!loaded.ok) {
      checks.push({
        name: `plan:${opts.planPath}`,
        ok: false,
        detail: loaded.reason,
        hint: loaded.detail ? JSON.stringify(loaded.detail) : undefined,
      });
    } else {
      checks.push({
        name: `plan:${loaded.plan.name}`,
        ok: true,
        detail: `${loaded.plan.steps.length} step(s); kinds: ${loaded.plan.steps.map((s) => s.kind).join(", ")}`,
      });
    }
  }

  for (const c of checks) {
    logger.emit("doctor.check", c as unknown as Record<string, unknown>);
  }

  const ok = checks.every((c) => c.ok);
  const finishedAt = env.clock.isoNow();
  const envelope: BankaiEnvelope = {
    ok,
    command: "doctor",
    startedAt,
    finishedAt,
    durationMs: env.clock.now() - startedNow,
    runId: logger.runId,
    logFile: logger.logFilePath,
    steps: [],
    checks,
    failure: ok ? undefined : { stage: "doctor", reason: `${checks.filter((c) => !c.ok).length} check(s) failed` },
  };
  logger.emit("doctor.end", { ok, total: checks.length });
  await logger.close();
  return envelope;
}
