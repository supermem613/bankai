import { spawn, ChildProcess, SpawnOptions } from "node:child_process";
import { Readable } from "node:stream";

// SpawnHeadless: the only sanctioned way to start a long-lived child process
// in bankai. Invariants the next editor must preserve:
//   1. shell must be false. Anything that goes through cmd.exe or
//      /bin/sh introduces quoting bugs and lets unsanitized strings execute.
//   2. windowsHide must be true. Without this, the legacy Start-Process
//      pattern leaves orphan console windows in headless CI runs.
//   3. The returned descriptor must surface its options for inspection so
//      the Skeptic probe and future tests can assert headlessness without
//      relying on visual confirmation.

export interface HeadlessSpawnDescriptor {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export interface HeadlessOptions {
  readonly shell: false;
  readonly windowsHide: true;
}

export interface HeadlessExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  killed: boolean;
}

export interface HeadlessChild {
  readonly pid: number | undefined;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly options: HeadlessOptions;
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(signal?: NodeJS.Signals): Promise<HeadlessExitResult>;
}

export function spawnHeadless(descriptor: HeadlessSpawnDescriptor): HeadlessChild {
  const opts: SpawnOptions = {
    cwd: descriptor.cwd,
    env: descriptor.env as NodeJS.ProcessEnv | undefined,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  };

  const child: ChildProcess = spawn(descriptor.command, descriptor.args ?? [], opts);

  if (!child.stdout || !child.stderr) {
    throw new Error("spawnHeadless: stdio must produce stdout and stderr streams");
  }
  const stdout = child.stdout;
  const stderr = child.stderr;

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });

  let killed = false;

  return {
    pid: child.pid,
    stdout,
    stderr,
    options: { shell: false, windowsHide: true },
    exit,
    async kill(signal: NodeJS.Signals = "SIGTERM"): Promise<HeadlessExitResult> {
      killed = true;
      child.kill(signal);
      const result = await exit;
      return { ...result, killed };
    },
  };
}
