import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

export interface VisibleTerminalLaunchOptions {
  cwd: string;
  execPath: string;
  cliPath: string;
  planPath: string;
  logFile: string;
  transcriptFile: string;
  pathEnv?: string;
  pathext?: string;
  logDir?: string;
  bindingsFile?: string;
  bindingsJson?: string;
  out?: string;
}

export interface VisibleTerminalLaunchResult {
  launched: boolean;
  pid?: number;
  logFile: string;
  transcriptFile: string;
}

export interface VisibleTerminalSpawnCommand {
  command: string;
  args: string[];
}

function findOnPath(command: string, pathEnv: string | undefined, pathext: string | undefined): string | undefined {
  const dirs = (pathEnv ?? "").split(delimiter).filter((dir) => dir.length > 0);
  const exts = (pathext ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.toLowerCase());
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

export function buildVisibleTerminalChildArgs(opts: VisibleTerminalLaunchOptions): string[] {
  const args = [opts.cliPath, "run", opts.planPath, "--visible-attached-terminal", "--log-file", opts.logFile];
  for (const [key, value] of [
    ["--log-dir", opts.logDir],
    ["--bindings-file", opts.bindingsFile],
    ["--bindings-json", opts.bindingsJson],
    ["--out", opts.out],
  ] as const) {
    if (typeof value === "string") {
      args.push(key, value);
    }
  }
  return args;
}

function buildPowerShellDirectCommand(opts: VisibleTerminalLaunchOptions): string {
  const childArgs = buildVisibleTerminalChildArgs(opts);
  return [
    `Set-Location ${psQuote(opts.cwd)}`,
    `& ${psQuote(opts.execPath)} ${childArgs.map(psQuote).join(" ")}`,
  ].join("; ");
}

export function buildVisibleTerminalSpawnCommand(opts: VisibleTerminalLaunchOptions): VisibleTerminalSpawnCommand {
  const wt = findOnPath("wt", opts.pathEnv, opts.pathext);
  const command = buildPowerShellDirectCommand(opts);
  if (wt) {
    return {
      command: "cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        "start",
        "",
        "/min",
        wt,
        "--window",
        "new",
        "new-tab",
        "--title",
        "Bankai attached process",
        "--startingDirectory",
        opts.cwd,
        "pwsh",
        "-NoProfile",
        "-Command",
        command,
      ],
    };
  }
  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "start", "", "/min", "/D", opts.cwd, "pwsh", "-NoProfile", "-Command", command],
  };
}

export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildVisibleTerminalPowerShellCommand(opts: VisibleTerminalLaunchOptions): string {
  const transcript = psQuote(opts.transcriptFile);
  return [
    `"Bankai visible terminal transcript started $(Get-Date -Format o)" | Out-File -FilePath ${transcript} -Encoding utf8 -Append`,
  ].join("; ");
}

export function launchVisibleTerminal(opts: VisibleTerminalLaunchOptions): VisibleTerminalLaunchResult {
  mkdirSync(dirname(opts.logFile), { recursive: true });
  mkdirSync(dirname(opts.transcriptFile), { recursive: true });
  appendFileSync(opts.transcriptFile, `Bankai visible terminal launcher created ${new Date().toISOString()}\n`);
  appendFileSync(opts.transcriptFile, `Bankai visible terminal child log: ${opts.logFile}\n`);

  const launcher = buildVisibleTerminalSpawnCommand(opts);
  const child = spawn(launcher.command, launcher.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  return {
    launched: true,
    pid: child.pid,
    logFile: opts.logFile,
    transcriptFile: opts.transcriptFile,
  };
}
