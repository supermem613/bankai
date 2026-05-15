import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join, delimiter } from "node:path";
import { findOnPath, discoverKashEntrypoint } from "../../src/tools/kash.js";
import type { Env } from "../../src/env-runtime/env.js";

// Pure-function tests for kash discovery. We construct fake Env objects with
// custom PATH/PATHEXT/exec/platform so we can test the Windows .cmd resolution
// path on any host. INVARIANT: discovery never reads from process.* directly.
// If these tests pass on Linux but fail on Windows or vice versa, the plugin
// is reading host state outside the injected Env.

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

describe("kash plugin: findOnPath", () => {
  it("finds a binary by walking PATH and returns the first match", () => {
    const dir = mkdtempSync(join(tmpdir(), "bankai-kashpath-"));
    try {
      const a = join(dir, "a");
      const b = join(dir, "b");
      mkdirSync(a);
      mkdirSync(b);
      const expected = join(b, "thing");
      writeFileSync(expected, "");
      const env = makeEnv({
        env: { PATH: `${a}${delimiter}${b}` },
        platform: "linux",
      });
      const found = findOnPath(env, "thing");
      assert.equal(found, expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined when the binary is not on PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "bankai-kashpath-miss-"));
    try {
      const env = makeEnv({ env: { PATH: dir }, platform: "linux" });
      const found = findOnPath(env, "definitely-not-a-real-binary-xyz");
      assert.equal(found, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("respects PATHEXT on Windows-platform Env even on a non-Windows host", () => {
    const dir = mkdtempSync(join(tmpdir(), "bankai-kashpathext-"));
    try {
      const candidate = join(dir, "kash.cmd");
      writeFileSync(candidate, "@echo off\r\n");
      const env = makeEnv({
        env: { PATH: dir, PATHEXT: ".COM;.EXE;.CMD" },
        platform: "win32",
      });
      const found = findOnPath(env, "kash");
      assert.equal(found, candidate, "PATHEXT walk should land on the .cmd shim");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("kash plugin: discoverKashEntrypoint", () => {
  it("returns undefined when kash is not on PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "bankai-kashdisc-miss-"));
    try {
      const env = makeEnv({ env: { PATH: dir }, platform: "linux" });
      assert.equal(discoverKashEntrypoint(env), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("on Windows, resolves a kash.cmd shim to node + dist/cli.js when linked", () => {
    const dir = mkdtempSync(join(tmpdir(), "bankai-kashdisc-win-"));
    try {
      const cmd = join(dir, "kash.cmd");
      writeFileSync(cmd, "@echo off\r\n");
      const distDir = join(dir, "node_modules", "kash", "dist");
      mkdirSync(distDir, { recursive: true });
      const cliJs = join(distDir, "cli.js");
      writeFileSync(cliJs, "// stub");
      const fakeNode = "C:/fake/node.exe";
      const env = makeEnv({
        env: { PATH: dir, PATHEXT: ".COM;.EXE;.CMD" },
        platform: "win32",
        exec: fakeNode,
      });
      const ep = discoverKashEntrypoint(env);
      assert.ok(ep, "expected a resolved entrypoint");
      assert.equal(ep!.binary, fakeNode);
      assert.deepEqual(ep!.baseArgs, [cliJs]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("on Windows, falls back to spawning the .cmd directly when the linked JS is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "bankai-kashdisc-winfallback-"));
    try {
      const cmd = join(dir, "kash.cmd");
      writeFileSync(cmd, "@echo off\r\n");
      const env = makeEnv({
        env: { PATH: dir, PATHEXT: ".COM;.EXE;.CMD" },
        platform: "win32",
      });
      const ep = discoverKashEntrypoint(env);
      assert.ok(ep);
      assert.equal(ep!.binary, cmd);
      assert.deepEqual(ep!.baseArgs, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("on POSIX, returns the discovered binary path with no baseArgs", () => {
    const dir = mkdtempSync(join(tmpdir(), "bankai-kashdisc-posix-"));
    try {
      const bin = join(dir, "kash");
      writeFileSync(bin, "#!/bin/sh\n");
      const env = makeEnv({ env: { PATH: dir }, platform: "linux" });
      const ep = discoverKashEntrypoint(env);
      assert.ok(ep);
      assert.equal(ep!.binary, bin);
      assert.deepEqual(ep!.baseArgs, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Smoke check that the host this test runs on is sane. Not a contract test,
// just guards against an outright broken tmpdir on the runner.
describe("kash plugin: host sanity", () => {
  it("can create and read back a tmp file", () => {
    const dir = mkdtempSync(join(tmpdir(), "bankai-sanity-"));
    try {
      const f = join(dir, "x");
      writeFileSync(f, "y");
      assert.equal(readFileSync(f, "utf8"), "y");
      assert.ok(existsSync(f));
      assert.ok(["linux", "darwin", "win32"].includes(platform()));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
