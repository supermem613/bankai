import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { BankaiTestEnvelope } from "../../src/schema/envelope.js";

// End-to-end integration test: invokes the CLI as a child process against a
// generated scenario JSON, parses the envelope, and asserts the structured
// shape. INVARIANT: the envelope contract is what consumers depend on. Adding
// fields is allowed without bumping schemaVersion. Removing or renaming
// fields requires a version bump.

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

describe("bankai test run end-to-end", () => {
  it("runs a passing scenario and exits 0 with ok envelope", () => {
    const dir = mkdtempSync(join(tmpdir(), "bankai-it-pass-"));
    try {
      const scenario = {
        schemaVersion: "1",
        name: "echo-hello",
        steps: [
          {
            kind: "shell",
            id: "say-hello",
            command: process.execPath,
            args: ["-e", "process.stdout.write('hello bankai world')"],
            timeoutMs: 10000,
          },
        ],
        assertions: [
          {
            kind: "step-output-contains",
            id: "stdout-has-hello",
            stepId: "say-hello",
            stream: "stdout",
            text: "hello bankai",
          },
        ],
      };
      const path = join(dir, "echo-hello.test.json");
      writeFileSync(path, JSON.stringify(scenario));

      const { envelope, exitCode } = runCli(path);
      assert.equal(exitCode, 0, "CLI must exit 0 on pass");
      assert.equal(envelope.schemaVersion, "1");
      assert.equal(envelope.ok, true);
      assert.equal(envelope.scenario, "echo-hello");
      assert.equal(envelope.steps.length, 1);
      assert.equal(envelope.steps[0].ok, true);
      assert.equal(envelope.steps[0].id, "say-hello");
      assert.equal(envelope.steps[0].exitCode, 0);
      assert.equal(envelope.assertions.length, 1);
      assert.equal(envelope.assertions[0].ok, true);
      assert.equal(envelope.failure, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs a failing assertion and exits 1 with failure envelope", () => {
    const dir = mkdtempSync(join(tmpdir(), "bankai-it-assertion-fail-"));
    try {
      const scenario = {
        schemaVersion: "1",
        name: "missing-text",
        steps: [
          {
            kind: "shell",
            id: "say-hello",
            command: process.execPath,
            args: ["-e", "process.stdout.write('actual output')"],
            timeoutMs: 10000,
          },
        ],
        assertions: [
          {
            kind: "step-output-contains",
            id: "stdout-has-something-missing",
            stepId: "say-hello",
            stream: "stdout",
            text: "GOODBYE",
          },
        ],
      };
      const path = join(dir, "missing-text.test.json");
      writeFileSync(path, JSON.stringify(scenario));

      const { envelope, exitCode } = runCli(path);
      assert.equal(exitCode, 1, "CLI must exit 1 on assertion failure");
      assert.equal(envelope.ok, false);
      assert.equal(envelope.steps[0].ok, true, "step itself ran ok");
      assert.equal(envelope.assertions[0].ok, false);
      assert.ok(envelope.failure, "failure must be populated");
      assert.equal(envelope.failure?.stage, "assertion");
      assert.equal(envelope.failure?.id, "stdout-has-something-missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unknown step kind at validation and never runs steps", () => {
    const dir = mkdtempSync(join(tmpdir(), "bankai-it-bad-kind-"));
    try {
      const scenario = {
        schemaVersion: "1",
        name: "bad-kind",
        steps: [{ kind: "definitely-not-a-real-kind", id: "x" }],
      };
      const path = join(dir, "bad-kind.test.json");
      writeFileSync(path, JSON.stringify(scenario));

      const { envelope, exitCode } = runCli(path);
      assert.equal(exitCode, 1);
      assert.equal(envelope.ok, false);
      assert.equal(envelope.steps.length, 0, "no steps must run on validation failure");
      assert.equal(envelope.failure?.stage, "validation");
      assert.match(envelope.failure?.reason ?? "", /unknown step kind/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a malformed scenario JSON file with a clear failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "bankai-it-bad-json-"));
    try {
      const path = join(dir, "broken.test.json");
      writeFileSync(path, "{ this is not valid json");

      const { envelope, exitCode } = runCli(path);
      assert.equal(exitCode, 1);
      assert.equal(envelope.ok, false);
      assert.equal(envelope.failure?.stage, "validation");
      assert.match(envelope.failure?.reason ?? "", /invalid JSON/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves a relative shell step cwd against the scenario directory, not process.cwd", () => {
    // Regression: the bankai-self-doctor canary surfaced this. Without
    // resolving spec.cwd against ctx.workDir, Node would resolve a relative
    // cwd against the process that invoked bankai. That makes scenarios
    // unportable. The contract is: relative cwd is always relative to the
    // scenario file's directory.
    const outer = mkdtempSync(join(tmpdir(), "bankai-it-relcwd-outer-"));
    try {
      const scenarioDir = join(outer, "scenarios");
      const sentinelDir = join(outer, "sibling");
      mkdirSync(scenarioDir);
      mkdirSync(sentinelDir);
      const sentinelPath = join(sentinelDir, "marker.txt");
      writeFileSync(sentinelPath, "marker contents");

      const scenario = {
        schemaVersion: "1",
        name: "relative-cwd",
        steps: [
          {
            kind: "shell",
            id: "print-cwd",
            command: process.execPath,
            args: ["-e", "process.stdout.write(process.cwd())"],
            cwd: "../sibling",
            timeoutMs: 10000,
          },
        ],
        assertions: [
          {
            kind: "step-output-contains",
            id: "stdout-is-sibling-dir",
            stepId: "print-cwd",
            stream: "stdout",
            text: "sibling",
          },
        ],
      };
      const path = join(scenarioDir, "relative-cwd.test.json");
      writeFileSync(path, JSON.stringify(scenario));

      const { envelope, exitCode } = runCli(path);
      assert.equal(exitCode, 0, "CLI must exit 0");
      assert.equal(envelope.ok, true);
      assert.equal(envelope.steps[0].ok, true);
      const stdout = envelope.steps[0].stdout ?? "";
      assert.ok(
        stdout.endsWith("sibling"),
        `step cwd should have resolved to <outer>/sibling. stdout was: ${stdout}`,
      );
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it("uses an absolute shell step cwd as-is without re-resolving", () => {
    const outer = mkdtempSync(join(tmpdir(), "bankai-it-abscwd-outer-"));
    try {
      const targetDir = join(outer, "target");
      mkdirSync(targetDir);
      const path = join(outer, "abs.test.json");

      const scenario = {
        schemaVersion: "1",
        name: "absolute-cwd",
        steps: [
          {
            kind: "shell",
            id: "print-cwd",
            command: process.execPath,
            args: ["-e", "process.stdout.write(process.cwd())"],
            cwd: targetDir,
            timeoutMs: 10000,
          },
        ],
        assertions: [
          {
            kind: "step-output-contains",
            id: "stdout-is-target",
            stepId: "print-cwd",
            stream: "stdout",
            text: "target",
          },
        ],
      };
      writeFileSync(path, JSON.stringify(scenario));

      const { envelope, exitCode } = runCli(path);
      assert.equal(exitCode, 0);
      assert.equal(envelope.ok, true);
      const stdout = envelope.steps[0].stdout ?? "";
      assert.ok(stdout.endsWith("target"), `expected absolute cwd to be honored. stdout was: ${stdout}`);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });
});
