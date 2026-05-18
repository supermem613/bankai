import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveShellCommand, type ShellStepV1 } from "../../src/steps/shell.js";
import type { Env } from "../../src/env-runtime/env.js";

function makeEnv(overrides: Partial<Env>): Env {
  return {
    home: "/fake-home",
    cwd: "/fake-cwd",
    env: {},
    exec: "/fake/node",
    platform: "linux",
    clock: { now: () => 0, isoNow: () => "1970-01-01T00:00:00.000Z" },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    ...overrides,
  };
}

function shell(overrides: Partial<ShellStepV1>): ShellStepV1 {
  return {
    kind: "shell",
    id: "s",
    command: "node",
    args: [],
    resolveCommand: true,
    timeoutMs: 30_000,
    expectExitCode: 0,
    retries: 0,
    maxBufferBytes: 1_048_576,
    ...overrides,
  };
}

describe("shell command resolution", () => {
  it("preserves Windows command shims through cmd.exe", () => {
    const dir = mkdtempSync(join(tmpdir(), "bankai-shell-cmd-"));
    try {
      const shim = join(dir, "agent.cmd");
      writeFileSync(shim, "@echo off\r\n");
      const env = makeEnv({
        platform: "win32",
        env: { PATH: dir, PATHEXT: ".COM;.EXE;.CMD", COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
      });

      const resolved = resolveShellCommand(shell({ command: "agent", args: ["prompt", "--out", "response.txt"] }), env);

      assert.equal(resolved.command, "C:\\Windows\\System32\\cmd.exe");
      assert.deepEqual(resolved.args, [
        "/d",
        "/s",
        "/c",
        `"${[`"${shim}"`, `"prompt"`, `"--out"`, `"response.txt"`].join(" ")}"`,
      ]);
      assert.equal(resolved.windowsVerbatimArguments, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("can leave command resolution disabled for exact argv control", () => {
    const env = makeEnv({ platform: "win32", env: {} });
    const resolved = resolveShellCommand(shell({ command: "agent", args: ["x"], resolveCommand: false }), env);

    assert.deepEqual(resolved, { command: "agent", args: ["x"], detail: "agent" });
  });
});
