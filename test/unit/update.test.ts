import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNodeEnv } from "../../src/env-runtime/env.js";
import { gitPullMadeNoChanges, runUpdateCommand, type CommandResult } from "../../src/commands/update.js";

describe("update command", () => {
  it("skips install and build when git pull made no changes", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bankai-update-"));
    try {
      const commands: string[] = [];
      const envelope = await runUpdateCommand({
        env: createNodeEnv({ cwd: tmp }),
        repoRoot: tmp,
        logDir: join(tmp, "logs"),
        isGitRepo: async () => true,
        runCommand: async (command, args) => {
          commands.push(`${command} ${args.join(" ")}`);
          return commandResult("Already up to date.\n");
        },
      });

      assert.equal(envelope.ok, true, JSON.stringify(envelope.failure));
      assert.deepEqual(commands, ["git pull --ff-only"]);
      assert.deepEqual(envelope.steps.map((step) => step.id), ["git-pull"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("runs install and build when git pull returns changes", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bankai-update-"));
    try {
      const commands: string[] = [];
      const envelope = await runUpdateCommand({
        env: createNodeEnv({ cwd: tmp }),
        repoRoot: tmp,
        logDir: join(tmp, "logs"),
        isGitRepo: async () => true,
        runCommand: async (command, args) => {
          commands.push(`${command} ${args.join(" ")}`);
          return commandResult(command === "git" ? "Fast-forward\n package.json | 2 +-\n" : "");
        },
      });

      assert.equal(envelope.ok, true, JSON.stringify(envelope.failure));
      assert.deepEqual(commands, [
        "git pull --ff-only",
        "npm install --no-audit --no-fund",
        "npm run build",
      ]);
      assert.deepEqual(envelope.steps.map((step) => step.id), ["git-pull", "npm-install", "npm-build"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reports validation failure outside a git checkout", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bankai-update-"));
    try {
      const envelope = await runUpdateCommand({
        env: createNodeEnv({ cwd: tmp }),
        repoRoot: tmp,
        logDir: join(tmp, "logs"),
        isGitRepo: async () => false,
      });

      assert.equal(envelope.ok, false);
      assert.equal(envelope.failure?.stage, "validation");
      assert.match(envelope.failure?.reason ?? "", /not a git repository/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("recognizes current and legacy no-change git pull output", () => {
    assert.equal(gitPullMadeNoChanges("Already up to date."), true);
    assert.equal(gitPullMadeNoChanges("Already up-to-date."), true);
    assert.equal(gitPullMadeNoChanges("Updating abc..def\nFast-forward"), false);
  });
});

function commandResult(stdout: string, stderr = "", exitCode = 0): CommandResult {
  return {
    exitCode,
    stdout,
    stderr,
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
  };
}
