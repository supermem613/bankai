import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildVisibleTerminalPowerShellCommand, buildVisibleTerminalSpawnCommand } from "../../src/visible-terminal.js";

describe("visible terminal launcher", () => {
  const launchOpts = {
    cwd: "C:\\repo",
    execPath: "C:\\node\\node.exe",
    cliPath: "C:\\repo\\dist\\cli.js",
    planPath: "C:\\plans\\dev.json",
    logFile: "C:\\Users\\alice\\.bankai\\logs\\run.jsonl",
    transcriptFile: "C:\\Users\\alice\\.bankai\\logs\\run.jsonl.terminal.txt",
  };

  it("prefers Windows Terminal and starts it minimized with an interactive PowerShell", () => {
    const tmp = mkdtempSync(join(tmpdir(), "bankai-visible-terminal-"));
    try {
      writeFileSync(join(tmp, "wt.exe"), "");
      assert.deepEqual(buildVisibleTerminalSpawnCommand({ ...launchOpts, pathEnv: tmp, pathext: ".EXE" }), {
        command: "cmd.exe",
        args: [
          "/d",
          "/s",
          "/c",
          "start",
          "",
          "/min",
          join(tmp, "wt.exe"),
          "--window",
          "new",
          "new-tab",
          "--title",
          "Bankai attached process",
          "--startingDirectory",
          "C:\\repo",
          "pwsh",
          "-NoProfile",
          "-Command",
          "Set-Location 'C:\\repo'; & 'C:\\node\\node.exe' 'C:\\repo\\dist\\cli.js' 'run' 'C:\\plans\\dev.json' '--visible-attached-terminal' '--log-file' 'C:\\Users\\alice\\.bankai\\logs\\run.jsonl'",
        ],
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to minimized cmd start with an empty title when Windows Terminal is unavailable", () => {
    assert.deepEqual(buildVisibleTerminalSpawnCommand({ ...launchOpts, pathEnv: "", pathext: ".EXE" }), {
      command: "cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        "start",
        "",
        "/min",
        "/D",
        "C:\\repo",
        "pwsh",
        "-NoProfile",
        "-Command",
        "Set-Location 'C:\\repo'; & 'C:\\node\\node.exe' 'C:\\repo\\dist\\cli.js' 'run' 'C:\\plans\\dev.json' '--visible-attached-terminal' '--log-file' 'C:\\Users\\alice\\.bankai\\logs\\run.jsonl'",
      ],
    });
  });

  it("passes the parent ready event file to the visible terminal child", () => {
    const command = buildVisibleTerminalSpawnCommand({
      ...launchOpts,
      pathEnv: "",
      pathext: ".EXE",
      visibleReadyEventFile: "C:\\Users\\alice\\.bankai\\logs\\run.jsonl.ready.json",
    });

    assert.match(command.args.at(-1) ?? "", /'--visible-ready-event-file' 'C:\\Users\\alice\\.bankai\\logs\\run\.jsonl\.ready\.json'/);
  });

  it("creates a launch transcript marker without wrapping the child command", () => {
    const command = buildVisibleTerminalPowerShellCommand(launchOpts);

    assert.doesNotMatch(command, /--log-file/);
    assert.doesNotMatch(command, /Tee-Object/);
    assert.match(command, /run\.jsonl\.terminal\.txt/);
    assert.doesNotMatch(command, /Read-Host/);
    assert.doesNotMatch(command, /NoExit/);
  });
});
