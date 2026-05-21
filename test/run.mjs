// Cross-platform test runner — expands glob and passes files to node --test.
// Sandboxes HOME/USERPROFILE to a tmpdir so tests cannot read the developer's
// real ~/.bankai/ state, mirroring CI exactly. Set BANKAI_TEST_REAL_HOME=1 to opt out.
//
// Avoids `node --test` worker subprocesses (their IPC pipe intermittently
// fails on Windows runners with deserialize errors). Uses node:test auto-start
// in a single process with a TAP reporter for the aggregate summary.
import { readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { minimatch } from "minimatch";
import { execSync } from "node:child_process";

const pattern = process.argv[2] || "test/**/*.test.ts";
const baseDir = pattern.split(/[/\\]/)[0] || ".";
const allFiles = readdirSync(baseDir, { recursive: true })
  .map((f) => join(baseDir, f).split("\\").join("/"))
  .filter((f) => minimatch(f, pattern));

if (allFiles.length === 0) {
  console.error(`No test files found matching: ${pattern}`);
  process.exit(1);
}

const sandboxHome = process.env.BANKAI_TEST_REAL_HOME
  ? null
  : mkdtempSync(join(tmpdir(), "bankai-test-home-"));

const env = { ...process.env };
if (sandboxHome) {
  env.HOME = sandboxHome;
  env.USERPROFILE = sandboxHome;
  env.LOCALAPPDATA = join(sandboxHome, "AppData", "Local");
}

// Per-file timeout for the spawned node:test run. --test-timeout fails any
// single it()/test() that exceeds the limit so a slow test gets a real TAP
// failure with name+location instead of an indefinite hang. The execSync
// timeout backstop covers the case where the hang is outside any registered
// test (top-level import side-effects, beforeEach, unclosed handles holding
// the process open past the suite's final 'plan' marker). Without these,
// a single hung file pegs the entire run at the GH Actions default 6h
// job timeout, with no diagnostic about which file or test was stuck.
const PER_TEST_TIMEOUT_MS = 120_000;
const PER_FILE_TIMEOUT_MS = 180_000;

let exitCode = 0;
let totalTests = 0;
let totalPass = 0;
let totalFail = 0;
const failedFiles = [];
const timedOutFiles = [];
try {
  for (const file of allFiles) {
    const cmd = `node --import tsx --test-reporter=tap --test-timeout=${PER_TEST_TIMEOUT_MS} ${file}`;
    let stdout = "";
    let fileFailed = false;
    try {
      stdout = execSync(cmd, {
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
        timeout: PER_FILE_TIMEOUT_MS,
        killSignal: "SIGKILL",
      });
    } catch (err) {
      fileFailed = true;
      stdout = (err.stdout ?? "").toString();
      if (err.signal === "SIGKILL" || err.code === "ETIMEDOUT") {
        timedOutFiles.push(file);
        stdout += `\n# RUNNER TIMEOUT: ${file} did not exit within ${PER_FILE_TIMEOUT_MS}ms and was killed\n`;
      }
      failedFiles.push(file);
    }
    process.stdout.write(stdout);
    const tests = parseInt((stdout.match(/^# tests (\d+)/m) ?? [])[1] ?? "0", 10);
    const pass  = parseInt((stdout.match(/^# pass (\d+)/m)  ?? [])[1] ?? "0", 10);
    const fail  = parseInt((stdout.match(/^# fail (\d+)/m)  ?? [])[1] ?? "0", 10);
    totalTests += tests;
    totalPass += pass;
    totalFail += fail;
    if (fileFailed && fail === 0) {
      totalFail += 1;
    }
  }
  console.log(`\n# AGGREGATE: tests ${totalTests} | pass ${totalPass} | fail ${totalFail}`);
  if (failedFiles.length) {
    console.log(`# Failed files:\n${failedFiles.map((f) => `#   ${f}`).join("\n")}`);
    exitCode = 1;
  }
  if (timedOutFiles.length) {
    console.log(`# Timed-out files (killed after ${PER_FILE_TIMEOUT_MS}ms):\n${timedOutFiles.map((f) => `#   ${f}`).join("\n")}`);
  }
} finally {
  if (sandboxHome) {
    rmSync(sandboxHome, { recursive: true, force: true });
  }
}
process.exit(exitCode);
