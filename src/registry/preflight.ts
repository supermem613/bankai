import type { Env } from "../env-runtime/env.js";
import { isProcessAlive } from "../process-tree.js";
import { verifyFingerprint } from "../fingerprint.js";
import type { RegistryEntry } from "./types.js";
import type { RegistryStore } from "./store.js";

// Preflight check for `registerAs` names that must NOT collide with an
// already-running process. Used by `attached-process` (and the outer CLI's
// visible-terminal launch) to refuse to re-spawn when the same name is
// alive. The same precedent already lives in `runPersistentSetup`; this
// helper exists so the step and the CLI share one decision tree.
//
// Returns:
//   * { kind: "none" } - no entry. Caller spawns.
//   * { kind: "stale", entry, reason } - entry present but identity
//     cannot be confirmed (dead pid, fingerprint mismatch, or no
//     recorded fingerprint to verify against). Caller MUST prune the
//     entry and then spawn. Pruning is the caller's job so this helper
//     stays pure and easily unit-testable.
//   * { kind: "alive", entry, reason } - entry present, pid alive, and
//     fingerprint matches. Caller MUST fail with the canonical message
//     produced by `formatAlreadyRunningMessage`; do NOT kill, do NOT
//     prune, do NOT spawn.

export type RegisteredAliveCheck =
  | { kind: "none" }
  | { kind: "stale"; entry: RegistryEntry; reason: string }
  | { kind: "alive"; entry: RegistryEntry; reason: string };

export interface CheckRegisteredAliveOptions {
  env: Env;
  registry: RegistryStore;
  name: string;
}

export async function checkRegisteredAlive(
  opts: CheckRegisteredAliveOptions,
): Promise<RegisteredAliveCheck> {
  const entry = await opts.registry.getEntry(opts.name);
  if (!entry) {
    return { kind: "none" };
  }
  if (!isProcessAlive(entry.pid)) {
    return { kind: "stale", entry, reason: `pid ${entry.pid} is not alive` };
  }
  if (!entry.fingerprint) {
    // Without a recorded fingerprint we cannot prove the live pid is the
    // same process we registered. Refuse to assert identity. Treat as
    // stale so the caller prunes and respawns; this mirrors the
    // conservative posture in `verifyFingerprint`.
    return {
      kind: "stale",
      entry,
      reason: `pid ${entry.pid} is alive but registry has no recorded fingerprint to verify identity`,
    };
  }
  const v = await verifyFingerprint(entry.fingerprint, { pid: entry.pid, env: opts.env });
  if (!v.alive) {
    return { kind: "stale", entry, reason: v.detail };
  }
  if (!v.matches) {
    return { kind: "stale", entry, reason: v.detail };
  }
  return {
    kind: "alive",
    entry,
    reason: `pid ${entry.pid} is alive and fingerprint matches`,
  };
}

export interface AlreadyRunningMessageOptions {
  name: string;
  entry: RegistryEntry;
}

export function formatAlreadyRunningMessage(opts: AlreadyRunningMessageOptions): string {
  return (
    `attached-process "${opts.name}" is already running as pid ${opts.entry.pid} ` +
    `(registered ${opts.entry.registeredAt} from ${opts.entry.planPath}). ` +
    `Run \`bankai stop ${opts.name}\` first.`
  );
}
