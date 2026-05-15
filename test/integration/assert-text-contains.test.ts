import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { BankaiTestEnvelope } from "../../src/schema/envelope.js";

// Integration tests for the assert-text-contains assertion. INVARIANT: this
// assertion is the way scenarios verify outputs that step kinds write to disk
// (kash response files, generated artifacts). step-output-contains only sees
// stdout/stderr; it cannot see file contents. If a future refactor merges
// these two kinds, the contract here must be preserved.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliPath = join(repoRoot, "src", "cli.ts");

interface RunResult {
  envelope: BankaiTestEnvelope;
  exitCode: number;
}

function runCli(scenarioPath: string): RunResult {
  let exitCode = 0;
  let stdout = "";
  try {
    stdout = execFileSync(
      process.execPath,
      ["--import", "tsx", cliPath, "test", "run", scenarioPath, "--json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string };
    exitCode = typeof e.status === "number" ? e.status : 1;
    stdout = typeof e.stdout === "string" ? e.stdout : (e.stdout?.toString("utf8") ?? "");
  }
  const envelope = JSON.parse(stdout) as BankaiTestEnvelope;
  return { envelope, exitCode };
}

describe("assert-text-contains assertion", () => {
  it("passes when the file contains the substring (relative path)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bankai-atc-pass-"));
    try {
      writeFileSync(join(dir, "artifact.txt"), "hello world from artifact");
      const scenario = {
        schemaVersion: "1",
        name: "atc-pass",
        assertions: [
          {
            kind: "assert-text-contains",
            id: "has-hello",
            file: "artifact.txt",
            text: "world from",
          },
        ],
      };
      const path = join(dir, "atc-pass.test.json");
      writeFileSync(path, JSON.stringify(scenario));
      const { envelope, exitCode } = runCli(path);
      assert.equal(exitCode, 0);
      assert.equal(envelope.ok, true);
      assert.equal(envelope.assertions[0].ok, true);
      assert.match(envelope.assertions[0].detail, /contains/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails with a clear detail when the substring is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "bankai-atc-miss-"));
    try {
      writeFileSync(join(dir, "artifact.txt"), "actual contents");
      const scenario = {
        schemaVersion: "1",
        name: "atc-miss",
        assertions: [
          {
            kind: "assert-text-contains",
            id: "missing",
            file: "artifact.txt",
            text: "GOODBYE",
          },
        ],
      };
      const path = join(dir, "atc-miss.test.json");
      writeFileSync(path, JSON.stringify(scenario));
      const { envelope, exitCode } = runCli(path);
      assert.equal(exitCode, 1);
      assert.equal(envelope.ok, false);
      assert.equal(envelope.assertions[0].ok, false);
      assert.match(envelope.assertions[0].detail, /does NOT contain/);
      assert.equal(envelope.failure?.stage, "assertion");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails with a clear detail when the file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "bankai-atc-noent-"));
    try {
      const scenario = {
        schemaVersion: "1",
        name: "atc-noent",
        assertions: [
          {
            kind: "assert-text-contains",
            id: "missing-file",
            file: "does-not-exist.txt",
            text: "anything",
          },
        ],
      };
      const path = join(dir, "atc-noent.test.json");
      writeFileSync(path, JSON.stringify(scenario));
      const { envelope, exitCode } = runCli(path);
      assert.equal(exitCode, 1);
      assert.equal(envelope.ok, false);
      assert.equal(envelope.assertions[0].ok, false);
      assert.match(envelope.assertions[0].detail, /could not read/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors an absolute file path verbatim", () => {
    const outer = mkdtempSync(join(tmpdir(), "bankai-atc-abs-outer-"));
    try {
      const target = join(outer, "absolute-artifact.txt");
      writeFileSync(target, "absolute content marker");
      const scenarioDir = mkdtempSync(join(tmpdir(), "bankai-atc-abs-scenario-"));
      try {
        const scenario = {
          schemaVersion: "1",
          name: "atc-abs",
          assertions: [
            {
              kind: "assert-text-contains",
              id: "has-marker",
              file: target,
              text: "marker",
            },
          ],
        };
        const path = join(scenarioDir, "atc-abs.test.json");
        writeFileSync(path, JSON.stringify(scenario));
        const { envelope, exitCode } = runCli(path);
        assert.equal(exitCode, 0);
        assert.equal(envelope.ok, true);
        assert.equal(envelope.assertions[0].ok, true);
      } finally {
        rmSync(scenarioDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });
});
