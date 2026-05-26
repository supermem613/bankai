import { existsSync, lstatSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Env } from "../env-runtime/env.js";

// resolveCommand: cross-platform shim resolution for spawned commands. The
// single source of truth used by shell, attached-process, and managed-process
// so plans can use bare names (rush, kash, node, npm) regardless of host OS.
//
// Invariants the next editor must preserve:
//   1. Path-qualified commands (containing / or \) are NEVER subject to PATH
//      lookup. The caller asked for a specific file. If the file does not
//      exist, that is reported with a path-specific error, not a PATH dump.
//   2. PATH walking uses PATHEXT on Windows and bare names on POSIX, mirroring
//      what shell:true would do. We deliberately do NOT consider an
//      extensionless candidate on Windows because Windows cannot execute
//      extensionless files directly.
//   3. .cmd and .bat shims are wrapped through ComSpec /d /s /c "<shim> <args>"
//      with windowsVerbatimArguments:true. This bypasses Node CVE-2024-27980
//      cleanly without enabling shell:true, and preserves arg fidelity via
//      cmd.exe's "" escape rule. Path-qualified .cmd/.bat that exist are also
//      wrapped, because direct spawn of a .cmd file fails with EINVAL on
//      modern Node.
//   4. originalCommand and originalArgs are always preserved on the result so
//      callers can record what was requested vs what actually ran.
//   5. A miss throws CommandNotFoundError with the searched extensions and
//      directories so users see a clear diagnostic instead of ENOENT.

export interface ResolvedCommand {
  command: string;
  args: string[];
  detail: string;
  windowsVerbatimArguments?: boolean;
  originalCommand: string;
  originalArgs: string[];
}

export class CommandNotFoundError extends Error {
  readonly originalCommand: string;
  readonly searchedExtensions: string[];
  readonly searchedDirectories: string[];
  constructor(command: string, searchedExtensions: string[], searchedDirectories: string[]) {
    const dirsPart = searchedDirectories.length > 0
      ? `directories=[${searchedDirectories.join(", ")}]`
      : "directories=[<PATH empty>]";
    super(
      `command "${command}" not found. searched extensions=[${searchedExtensions.join(", ")}], ${dirsPart}`,
    );
    this.name = "CommandNotFoundError";
    this.originalCommand = command;
    this.searchedExtensions = searchedExtensions;
    this.searchedDirectories = searchedDirectories;
  }
}

const WRAPPED_EXTS = new Set([".cmd", ".bat"]);

function isPathQualified(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

function pathDirs(env: Env): string[] {
  const pathVar = env.env.PATH ?? env.env.Path ?? "";
  return pathVar.split(delimiter).filter((dir) => dir.length > 0);
}

function pathExts(env: Env): string[] {
  return env.platform === "win32"
    ? (env.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.toLowerCase())
    : [""];
}

function quoteCmdArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

// pathEntryExists: existsSync follows the reparse target, which fails with
// EACCES on Windows AppX execution alias stubs (e.g. the 0-byte pwsh.exe
// reparse point under %LOCALAPPDATA%\Microsoft\WindowsApps that the Microsoft
// Store / winget MSIX install drops on PATH). The kernel resolves these on
// CreateProcess, so spawn works directly against the stub even though stat
// does not. Fall back to lstatSync so resolver accepts the entry whenever the
// directory entry itself exists, regardless of whether the target is
// reachable through normal stat.
function pathEntryExists(candidate: string): boolean {
  if (existsSync(candidate)) {
    return true;
  }
  try {
    lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(env: Env, command: string): string | undefined {
  for (const dir of pathDirs(env)) {
    for (const ext of pathExts(env)) {
      const candidate = join(dir, command + ext);
      if (pathEntryExists(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function wrapInComSpec(env: Env, executable: string, args: string[], originalCommand: string, originalArgs: string[]): ResolvedCommand {
  const cmd = env.env.ComSpec ?? env.env.COMSPEC ?? "cmd.exe";
  const commandLine = [quoteCmdArg(executable), ...args.map(quoteCmdArg)].join(" ");
  return {
    command: cmd,
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    detail: `${cmd} /d /s /c "${commandLine}"`,
    windowsVerbatimArguments: true,
    originalCommand,
    originalArgs,
  };
}

function shouldWrap(env: Env, executable: string): boolean {
  if (env.platform !== "win32") {
    return false;
  }
  const lower = executable.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot === -1) {
    return false;
  }
  return WRAPPED_EXTS.has(lower.slice(dot));
}

export function resolveCommand(command: string, args: string[], env: Env): ResolvedCommand {
  const originalCommand = command;
  const originalArgs = args;

  if (isPathQualified(command)) {
    if (!pathEntryExists(command)) {
      throw new CommandNotFoundError(command, [], []);
    }
    if (shouldWrap(env, command)) {
      return wrapInComSpec(env, command, args, originalCommand, originalArgs);
    }
    return { command, args, detail: command, originalCommand, originalArgs };
  }

  const discovered = findOnPath(env, command);
  if (!discovered) {
    throw new CommandNotFoundError(command, pathExts(env), pathDirs(env));
  }
  if (shouldWrap(env, discovered)) {
    return wrapInComSpec(env, discovered, args, originalCommand, originalArgs);
  }
  return { command: discovered, args, detail: discovered, originalCommand, originalArgs };
}
