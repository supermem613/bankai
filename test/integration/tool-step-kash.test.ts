import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { BankaiTestEnvelope } from "../../src/schema/envelope.js";

// Integration tests for the tool step kind dispatching to the kash plugin.
// We use a stand-in JS binary executed via process.execPath rather than the
// real kash CLI so the tests are hermetic and run on any host. INVARIANT:
// the kash plugin must run a stand-in identically to the real kash binary
// when given config.binary + config.baseArgs. If this test starts shelling
// out to a real kash on the developer's PATH, the plugin has stopped honoring
// config.binary and the contract is broken.

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

// Stand-in kash. Reads --prompt-file and --out from argv. Writes a fixed
// response to the out file. If KASH_STUB_FAIL_FIRST is set, the first call
// (detected via a counter file at KASH_STUB_COUNTER_FILE) exits non-zero.
// Hand-rolled to keep test infra dependency-free.
const KASH_STUB_SOURCE = `
const fs = require("node:fs");
const argv = process.argv.slice(2);
function arg(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const promptFile = arg("--prompt-file");
const outFile = arg("--out");
const subcommand = argv[0];
if (subcommand === "refresh") {
  process.stdout.write("refreshed\\n");
  process.exit(0);
}
if (!promptFile || !outFile) {
  process.stderr.write("missing --prompt-file or --out\\n");
  process.exit(2);
}
const counterFile = process.env.KASH_STUB_COUNTER_FILE;
let attempt = 1;
if (counterFile) {
  try {
    attempt = parseInt(fs.readFileSync(counterFile, "utf8"), 10) + 1;
  } catch {
    attempt = 1;
  }
  fs.writeFileSync(counterFile, String(attempt));
}
const failFirst = process.env.KASH_STUB_FAIL_FIRST === "1";
const failAlways = process.env.KASH_STUB_FAIL_ALWAYS === "1";
if (failAlways || (failFirst && attempt === 1)) {
  process.stderr.write("simulated kash failure attempt " + attempt + "\\n");
  process.exit(7);
}
const prompt = fs.readFileSync(promptFile, "utf8");
fs.writeFileSync(outFile, "RESPONSE FOR: " + prompt + " (attempt " + attempt + ")");
process.stdout.write("ok attempt " + attempt + "\\n");
process.exit(0);
`;

function writeStandInKash(dir: string): string {
  const path = join(dir, "kash-standin.cjs");
  writeFileSync(path, KASH_STUB_SOURCE);
  return path;
}

describe("tool step + kash plugin end-to-end", () => {
  it("invokes kash via config.binary and writes the response to outFile", () => {
    const dir = mkdtempSync(join(tmpdir(), "bankai-tool-kash-pass-"));
    try {
      const standin = writeStandInKash(dir);
      const promptFile = join(dir, "prompt.txt");
      writeFileSync(promptFile, "Hello, kash.");
      const outFile = join(dir, "response.txt");

      const scenario = {
        schemaVersion: "1",
        name: "kash-happy-path",
        steps: [
          {
            kind: "tool",
            id: "ask-kash",
            tool: "kash",
            config: { binary: process.execPath, baseArgs: [standin] },
            invocation: { promptFile, outFile },
            timeoutMs: 15000,
          },
        ],
        assertions: [
          {
            kind: "assert-text-contains",
            id: "out-has-response",
            file: outFile,
            text: "RESPONSE FOR: Hello, kash.",
          },
        ],
      };
      const path = join(dir, "kash-happy-path.test.json");
      writeFileSync(path, JSON.stringify(scenario));

      const { envelope, exitCode } = runCli(path);
      assert.equal(exitCode, 0, `expected pass. envelope: ${JSON.stringify(envelope)}`);
      assert.equal(envelope.ok, true);
      assert.equal(envelope.steps.length, 1);
      assert.equal(envelope.steps[0].kind, "tool");
      assert.equal(envelope.steps[0].ok, true);
      assert.equal(envelope.assertions[0].ok, true);
      assert.ok(existsSync(outFile));
      assert.match(readFileSync(outFile, "utf8"), /RESPONSE FOR: Hello, kash\./);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retries on first failure and succeeds on second attempt when refreshOnRetry is true", () => {
    const dir = mkdtempSync(join(tmpdir(), "bankai-tool-kash-retry-"));
    try {
      const standin = writeStandInKash(dir);
      const promptFile = join(dir, "prompt.txt");
      writeFileSync(promptFile, "retry me");
      const outFile = join(dir, "response.txt");
      const counter = join(dir, "counter.txt");

      // Override env for the CLI subprocess so the stand-in fails its first
      // attempt and succeeds the second. We pass these via the orchestrator
      // by piggy-backing on the env snapshot. The CLI inherits process.env so
      // we set the vars here in the parent before exec.
      process.env.KASH_STUB_FAIL_FIRST = "1";
      process.env.KASH_STUB_COUNTER_FILE = counter;

      try {
        const scenario = {
          schemaVersion: "1",
          name: "kash-retry-then-pass",
          steps: [
            {
              kind: "tool",
              id: "ask-kash",
              tool: "kash",
              config: {
                binary: process.execPath,
                baseArgs: [standin],
                retries: 1,
                refreshOnRetry: true,
                attemptTimeoutMs: 10000,
              },
              invocation: { promptFile, outFile },
              timeoutMs: 30000,
            },
          ],
          assertions: [
            {
              kind: "assert-text-contains",
              id: "out-has-attempt-2",
              file: outFile,
              text: "(attempt 2)",
            },
          ],
        };
        const path = join(dir, "kash-retry.test.json");
        writeFileSync(path, JSON.stringify(scenario));

        const { envelope, exitCode } = runCli(path);
        assert.equal(exitCode, 0, `expected pass after retry. envelope: ${JSON.stringify(envelope)}`);
        assert.equal(envelope.ok, true);
        assert.equal(envelope.steps[0].ok, true);
        // Counter must have advanced past the prompt attempts. Refresh between
        // attempts is also a stand-in invocation that bumps the counter, so
        // we just check it's at least the prompt-attempt count.
        const attempts = parseInt(readFileSync(counter, "utf8"), 10);
        assert.ok(attempts >= 2, `expected at least 2 stand-in invocations, got ${attempts}`);
      } finally {
        delete process.env.KASH_STUB_FAIL_FIRST;
        delete process.env.KASH_STUB_COUNTER_FILE;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when all retries are exhausted and reports the kash failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "bankai-tool-kash-allfail-"));
    try {
      const standin = writeStandInKash(dir);
      const promptFile = join(dir, "prompt.txt");
      writeFileSync(promptFile, "always fail");
      const outFile = join(dir, "response.txt");

      process.env.KASH_STUB_FAIL_ALWAYS = "1";
      try {
        const scenario = {
          schemaVersion: "1",
          name: "kash-all-fail",
          steps: [
            {
              kind: "tool",
              id: "ask-kash",
              tool: "kash",
              config: {
                binary: process.execPath,
                baseArgs: [standin],
                retries: 1,
                refreshOnRetry: false,
                attemptTimeoutMs: 5000,
              },
              invocation: { promptFile, outFile },
              timeoutMs: 30000,
            },
          ],
        };
        const path = join(dir, "kash-all-fail.test.json");
        writeFileSync(path, JSON.stringify(scenario));

        const { envelope, exitCode } = runCli(path);
        assert.equal(exitCode, 1, "CLI must exit 1 when all kash attempts fail");
        assert.equal(envelope.ok, false);
        assert.equal(envelope.steps[0].ok, false);
        assert.equal(envelope.steps[0].kind, "tool");
        assert.equal(envelope.failure?.stage, "step");
        assert.match(envelope.failure?.reason ?? "", /kash failed after 2 attempt/);
      } finally {
        delete process.env.KASH_STUB_FAIL_ALWAYS;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unknown tool kind at validation, before any step runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "bankai-tool-unknown-"));
    try {
      const scenario = {
        schemaVersion: "1",
        name: "unknown-tool",
        steps: [
          {
            kind: "tool",
            id: "x",
            tool: "definitely-not-a-real-tool",
            invocation: {},
          },
        ],
      };
      const path = join(dir, "unknown-tool.test.json");
      writeFileSync(path, JSON.stringify(scenario));

      const { envelope, exitCode } = runCli(path);
      assert.equal(exitCode, 1);
      assert.equal(envelope.ok, false);
      assert.equal(envelope.steps.length, 0, "no steps must run on validation failure");
      assert.equal(envelope.failure?.stage, "validation");
      assert.match(envelope.failure?.reason ?? "", /unknown tool kind/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an invalid kash invocation at validation (missing promptFile)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bankai-tool-bad-inv-"));
    try {
      const scenario = {
        schemaVersion: "1",
        name: "bad-invocation",
        steps: [
          {
            kind: "tool",
            id: "x",
            tool: "kash",
            config: { binary: process.execPath },
            invocation: { outFile: "out.txt" },
          },
        ],
      };
      const path = join(dir, "bad-invocation.test.json");
      writeFileSync(path, JSON.stringify(scenario));

      const { envelope, exitCode } = runCli(path);
      assert.equal(exitCode, 1);
      assert.equal(envelope.ok, false);
      assert.equal(envelope.failure?.stage, "validation");
      assert.match(envelope.failure?.reason ?? "", /invocation\.promptFile/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
