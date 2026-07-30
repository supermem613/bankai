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
      assert.deepEqual(commands, ["sd status", "git pull --ff-only"]);
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
        "sd status",
        "git pull --ff-only",
        "npm install --no-audit --no-fund",
        "npm run build",
      ]);
      assert.deepEqual(envelope.steps.map((step) => step.id), ["git-pull", "npm-install", "npm-build"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("uses sd pull and rebuilds when a soda-managed repo updates the worktree", async () => {
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
          if (command === "sd" && args[0] === "status") {
            return commandResult(sodaStatus(true));
          }
          if (command === "sd" && args[0] === "pull") {
            return commandResult(sodaPull([{ status: "updated", worktreeUpdated: true }]));
          }
          return commandResult("");
        },
      });

      assert.equal(envelope.ok, true, JSON.stringify(envelope.failure));
      assert.deepEqual(commands, [
        "sd status",
        "sd pull",
        "npm install --no-audit --no-fund",
        "npm run build",
      ]);
      assert.equal(commands.includes("git pull --ff-only"), false);
      assert.deepEqual(envelope.steps.map((step) => step.id), ["sd-pull", "npm-install", "npm-build"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips install and build when sd pull leaves the worktree unchanged", async () => {
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
          if (command === "sd" && args[0] === "status") {
            return commandResult(sodaStatus(true));
          }
          if (command === "sd" && args[0] === "pull") {
            return commandResult(sodaPull([
              { status: "up-to-date", worktreeUpdated: false },
              { status: "ahead", worktreeUpdated: false },
            ]));
          }
          return commandResult("");
        },
      });

      assert.equal(envelope.ok, true, JSON.stringify(envelope.failure));
      assert.deepEqual(commands, ["sd status", "sd pull"]);
      assert.deepEqual(envelope.steps.map((step) => step.id), ["sd-pull"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to git pull when sd status cannot prove soda management", async () => {
    const cases: Array<{ name: string; status: string; throws?: boolean }> = [
      { name: "ok false", status: JSON.stringify({ ok: false, error: "not initialized" }) },
      { name: "unparseable", status: "not json" },
      { name: "runner throwing", status: "", throws: true },
    ];

    for (const testCase of cases) {
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
            if (command === "sd" && args[0] === "status") {
              if (testCase.throws) {
                throw new Error("sd not found");
              }
              return commandResult(testCase.status);
            }
            return commandResult("Already up to date.\n");
          },
        });

        assert.equal(envelope.ok, true, testCase.name);
        assert.equal(commands.includes("git pull --ff-only"), true, testCase.name);
        assert.deepEqual(envelope.steps.map((step) => step.id), ["git-pull"], testCase.name);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  });

  it("reports sd pull envelope failures without install or build", async () => {
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
          if (command === "sd" && args[0] === "status") {
            return commandResult(sodaStatus(true));
          }
          if (command === "sd" && args[0] === "pull") {
            return commandResult(JSON.stringify({ ok: false, error: "soda refused pull" }));
          }
          return commandResult("");
        },
      });

      assert.equal(envelope.ok, false);
      assert.match(envelope.failure?.reason ?? "", /soda refused pull/);
      assert.deepEqual(commands, ["sd status", "sd pull"]);
      assert.deepEqual(envelope.steps.map((step) => step.id), ["sd-pull"]);
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

function sodaStatus(initialized: boolean): string {
  return JSON.stringify({ ok: true, data: { summary: { initialized } } });
}

function sodaPull(outcomes: Array<{ status: string; worktreeUpdated: boolean }>): string {
  return JSON.stringify({ ok: true, data: outcomes });
}
