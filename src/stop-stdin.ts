import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Env } from "./env-runtime/env.js";
import type { StopStrategy } from "./registry/types.js";
import { isProcessAlive } from "./process-tree.js";

// Shared stdin-based stop helper. Writes the configured input to the
// trigger file that the relay wrapper watches. Then polls for process
// exit within graceMs. Returns whether the process exited gracefully.
//
// Invariants:
//   1. The trigger file path comes from the persisted StopStrategy in
//      the registry entry. It was set at spawn time by managed-process.
//   2. The relay wrapper (a detached node process) watches for this
//      file and pipes its content to the real child's stdin on arrival.
//   3. If the process does not exit within graceMs, the caller must
//      fall back to process-tree termination.

export interface StdinStopResult {
  delivered: boolean;
  exited: boolean;
  detail: string;
}

export async function stopViaStdin(opts: {
  stop: StopStrategy & { kind: "stdin" };
  pid: number;
  graceMs: number;
  env: Env;
}): Promise<StdinStopResult> {
  const { stop, pid, graceMs } = opts;

  if (!isProcessAlive(pid)) {
    return { delivered: false, exited: true, detail: "process already dead before stdin delivery" };
  }

  // Write the configured input to the trigger file.
  try {
    await mkdir(dirname(stop.stdinFile), { recursive: true });
    await writeFile(stop.stdinFile, stop.input, "utf8");
  } catch (err) {
    return {
      delivered: false,
      exited: false,
      detail: `failed to write stdin trigger file: ${(err as Error).message}`,
    };
  }

  // Poll for process exit within the grace period.
  const deadline = Date.now() + graceMs;
  const pollMs = 100;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return { delivered: true, exited: true, detail: "stdin input delivered; process exited gracefully" };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  if (!isProcessAlive(pid)) {
    return { delivered: true, exited: true, detail: "stdin input delivered; process exited gracefully" };
  }

  return {
    delivered: true,
    exited: false,
    detail: `stdin input delivered but process did not exit within ${graceMs}ms`,
  };
}
