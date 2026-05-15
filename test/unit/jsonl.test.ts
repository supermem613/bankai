import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeEnv } from "../../src/env-runtime/env.js";
import { createRunLogger, resolveLogFilePath } from "../../src/log/jsonl.js";

describe("log/jsonl", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "bankai-jsonl-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("emits one JSON object per line and closes cleanly", async () => {
    const env = createNodeEnv();
    const logger = createRunLogger({
      env,
      command: "run",
      logsDir: tmp,
      planName: "demo",
      runId: "abcd1234",
    });
    logger.emit("plan.start", { planName: "demo" });
    logger.emit("step.start", { stepId: "s1", kind: "shell" });
    logger.emit("step.end", { stepId: "s1", ok: true });
    await logger.close();
    const raw = readFileSync(logger.logFilePath, "utf8");
    const lines = raw.trim().split("\n");
    assert.equal(lines.length, 3);
    for (const l of lines) {
      const obj = JSON.parse(l) as { runId: string; command: string };
      assert.equal(obj.runId, "abcd1234");
      assert.equal(obj.command, "run");
    }
  });

  it("resolveLogFilePath honors explicit logFile override", () => {
    const env = createNodeEnv();
    const explicit = join(tmp, "explicit.jsonl");
    const p = resolveLogFilePath({ env, command: "run", logsDir: tmp, logFile: explicit });
    assert.equal(p, explicit);
  });

  it("resolveLogFilePath sanitizes plan name for safe filenames", () => {
    const env = createNodeEnv();
    const p = resolveLogFilePath({
      env,
      command: "run",
      logsDir: tmp,
      planName: "weird/name with spaces!",
      runId: "deadbeef",
    });
    assert.match(p, /weird_name_with_spaces_/);
    assert.match(p, /deadbeef\.jsonl$/);
  });

  it("emit never throws after close", async () => {
    const env = createNodeEnv();
    const logger = createRunLogger({ env, command: "run", logsDir: tmp, runId: "deadbeef" });
    await logger.close();
    logger.emit("after.close", { x: 1 });
    assert.equal(logger.err, undefined);
  });
});
