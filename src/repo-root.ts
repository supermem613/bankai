import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Env } from "./env-runtime/env.js";

// Discover a stable "repo root" for storing per-run JSONL logs and the
// (no longer used) per-repo state. Walks up from a starting directory
// looking for, in order:
//   1. Existing .bankai/ directory
//   2. .git/ directory
//   3. package.json file
// If none are found, the starting directory is used. This mirrors the
// rotunda/kash convention of letting users opt into a project boundary
// by simply having any of the three markers.
//
// INVARIANT: this function must NEVER read process.cwd directly. The
// starting directory is passed in. Tests pass tmpdirs.

export interface ResolveRepoRootOptions {
  env: Env;
  start?: string;
  override?: string;
}

export function resolveRepoRoot(opts: ResolveRepoRootOptions): string {
  if (opts.override) {
    return isAbsolute(opts.override) ? opts.override : resolve(opts.env.cwd, opts.override);
  }
  let dir = opts.start ?? opts.env.cwd;
  if (!isAbsolute(dir)) {
    dir = resolve(opts.env.cwd, dir);
  }
  let prev: string | undefined;
  while (dir && dir !== prev) {
    if (existsSync(resolve(dir, ".bankai"))) {
      return dir;
    }
    if (existsSync(resolve(dir, ".git"))) {
      return dir;
    }
    if (existsSync(resolve(dir, "package.json"))) {
      return dir;
    }
    prev = dir;
    dir = dirname(dir);
  }
  return opts.start ?? opts.env.cwd;
}
