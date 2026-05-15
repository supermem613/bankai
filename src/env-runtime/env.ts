// Env: injected dependency that bundles host-environment access for the
// engine and every step kind. Invariant the next editor must preserve: NO
// engine, step, assertion, or environment plugin file may read from
// process.env, process.cwd, or os.homedir directly. They receive an Env and
// read from it. This single chokepoint is what lets tests sandbox host state
// without silent leaks of real USERPROFILE through to "sandboxed" code.

export interface ClockFacade {
  now(): number;
  isoNow(): string;
}

export interface LoggerFacade {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface Env {
  readonly home: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly exec: string;
  readonly platform: NodeJS.Platform;
  readonly clock: ClockFacade;
  readonly logger: LoggerFacade;
}

export interface CreateNodeEnvOptions {
  cwd?: string;
  logger?: LoggerFacade;
}

const defaultLogger: LoggerFacade = {
  info: (m: string): void => {
    process.stdout.write(m + "\n");
  },
  warn: (m: string): void => {
    process.stderr.write(m + "\n");
  },
  error: (m: string): void => {
    process.stderr.write(m + "\n");
  },
};

export function createNodeEnv(opts: CreateNodeEnvOptions = {}): Env {
  // Snapshot HOME-equivalent and full env at construction. USERPROFILE is the
  // Windows native, HOME is POSIX. Test runners set both to a sandbox tmpdir.
  // exec and platform are also snapshotted here so tool plugins like kash can
  // reach the host node binary and OS family without re-reading process.*
  // outside this single chokepoint.
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const envSnapshot: Record<string, string | undefined> = { ...process.env };
  const cwd = opts.cwd ?? process.cwd();
  const logger = opts.logger ?? defaultLogger;

  return {
    home,
    cwd,
    env: Object.freeze(envSnapshot),
    exec: process.execPath,
    platform: process.platform,
    clock: {
      now: (): number => Date.now(),
      isoNow: (): string => new Date().toISOString(),
    },
    logger,
  };
}
