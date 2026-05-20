import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandNotFoundError, resolveCommand } from "../../src/spawn/resolve-command.js";
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

describe("resolveCommand (cross-platform shim resolution)", () => {
  it("wraps a Windows .cmd shim through ComSpec with verbatim quoting", () => {
    const dir = mkdtempSync(join(tmpdir(), "bankai-resolve-cmd-"));
    try {
      const shim = join(dir, "rush.cmd");
      writeFileSync(shim, "@echo off\r\n");
      const env = makeEnv({
        platform: "win32",
        env: { PATH: dir, PATHEXT: ".COM;.EXE;.CMD", ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      });

      const r = resolveCommand("rush", ["--quiet", "start"], env);

      assert.equal(r.command, "C:\\Windows\\System32\\cmd.exe");
      assert.deepEqual(r.args, [
        "/d",
        "/s",
        "/c",
        `"${[`"${shim}"`, `"--quiet"`, `"start"`].join(" ")}"`,
      ]);
      assert.equal(r.windowsVerbatimArguments, true);
      assert.equal(r.originalCommand, "rush");
      assert.deepEqual(r.originalArgs, ["--quiet", "start"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("wraps a Windows .bat shim through ComSpec", () => {
    const dir = mkdtempSync(join(tmpdir(), "bankai-resolve-bat-"));
    try {
      const shim = join(dir, "tool.bat");
      writeFileSync(shim, "@echo off\r\n");
      const env = makeEnv({
        platform: "win32",
        env: { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      });

      const r = resolveCommand("tool", ["x"], env);

      assert.equal(r.command, "C:\\Windows\\System32\\cmd.exe");
      assert.equal(r.windowsVerbatimArguments, true);
      assert.ok(r.detail.includes("tool.bat"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the discovered absolute path for a real .exe without wrapping", () => {
    const dir = mkdtempSync(join(tmpdir(), "bankai-resolve-exe-"));
    try {
      const exe = join(dir, "thing.exe");
      writeFileSync(exe, "");
      const env = makeEnv({
        platform: "win32",
        env: { PATH: dir, PATHEXT: ".COM;.EXE;.CMD" },
      });

      const r = resolveCommand("thing", ["a", "b"], env);

      assert.equal(r.command, exe);
      assert.deepEqual(r.args, ["a", "b"]);
      assert.equal(r.windowsVerbatimArguments, undefined);
      assert.equal(r.originalCommand, "thing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws CommandNotFoundError on Windows miss with PATHEXT + PATH dirs in the message", () => {
    const dir = mkdtempSync(join(tmpdir(), "bankai-resolve-miss-"));
    try {
      const env = makeEnv({
        platform: "win32",
        env: { PATH: dir, PATHEXT: ".COM;.EXE;.CMD" },
      });

      let caught: unknown;
      try {
        resolveCommand("totally-fake-cli", [], env);
      } catch (err) {
        caught = err;
      }
      assert.ok(caught instanceof CommandNotFoundError, "expected CommandNotFoundError");
      const err = caught as CommandNotFoundError;
      assert.ok(err.message.includes("totally-fake-cli"));
      assert.ok(err.message.includes(".cmd"));
      assert.ok(err.message.includes(dir));
      assert.deepEqual(err.searchedExtensions, [".com", ".exe", ".cmd"]);
      assert.deepEqual(err.searchedDirectories, [dir]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("path-qualified existing command on Windows passes through unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "bankai-resolve-abs-"));
    try {
      const exe = join(dir, "qualified.exe");
      writeFileSync(exe, "");
      const env = makeEnv({
        platform: "win32",
        env: { PATH: "", PATHEXT: ".COM;.EXE;.CMD" },
      });

      const r = resolveCommand(exe, ["arg1"], env);

      assert.equal(r.command, exe);
      assert.deepEqual(r.args, ["arg1"]);
      assert.equal(r.windowsVerbatimArguments, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("path-qualified .cmd on Windows is still ComSpec-wrapped to avoid EINVAL", () => {
    const dir = mkdtempSync(join(tmpdir(), "bankai-resolve-abscmd-"));
    try {
      const shim = join(dir, "qualified.cmd");
      writeFileSync(shim, "@echo off\r\n");
      const env = makeEnv({
        platform: "win32",
        env: { PATH: "", PATHEXT: ".COM;.EXE;.CMD", ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      });

      const r = resolveCommand(shim, ["x"], env);

      assert.equal(r.command, "C:\\Windows\\System32\\cmd.exe");
      assert.equal(r.windowsVerbatimArguments, true);
      assert.ok(r.detail.includes(shim));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("path-qualified missing command throws with the exact path in the message", () => {
    const env = makeEnv({
      platform: "win32",
      env: { PATH: "", PATHEXT: ".COM;.EXE;.CMD" },
    });

    let caught: unknown;
    try {
      resolveCommand("C:\\does\\not\\exist.exe", [], env);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof CommandNotFoundError);
    assert.ok((caught as Error).message.includes("C:\\does\\not\\exist.exe"));
  });

  it("POSIX walks PATH to the absolute executable without ComSpec wrapping", () => {
    const dir = mkdtempSync(join(tmpdir(), "bankai-resolve-posix-"));
    try {
      const exe = join(dir, "mycli");
      writeFileSync(exe, "#!/bin/sh\n");
      const env = makeEnv({
        platform: "linux",
        env: { PATH: dir },
      });

      const r = resolveCommand("mycli", ["arg"], env);

      assert.equal(r.command, exe);
      assert.deepEqual(r.args, ["arg"]);
      assert.equal(r.windowsVerbatimArguments, undefined);
      assert.equal(r.originalCommand, "mycli");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POSIX path-qualified existing command passes through", () => {
    const dir = mkdtempSync(join(tmpdir(), "bankai-resolve-posix-abs-"));
    try {
      const exe = join(dir, "qualified");
      writeFileSync(exe, "#!/bin/sh\n");
      const env = makeEnv({
        platform: "linux",
        env: { PATH: "" },
      });

      const r = resolveCommand(exe, [], env);

      assert.equal(r.command, exe);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POSIX miss throws CommandNotFoundError", () => {
    const env = makeEnv({
      platform: "linux",
      env: { PATH: "/no/such/dir" },
    });

    let caught: unknown;
    try {
      resolveCommand("totally-fake-cli", [], env);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof CommandNotFoundError);
    assert.ok((caught as Error).message.includes("totally-fake-cli"));
  });
});
