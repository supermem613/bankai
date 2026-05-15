import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { createNodeEnv } from "../../src/env-runtime/env.js";
import { spawnHeadless } from "../../src/spawn/spawn-headless.js";
import { FileStateStore } from "../../src/state/file-state-store.js";

// Skeptic probe: this single integration test exists to catch the three failure
// modes the consider-phase Skeptic identified as fatal. INVARIANT: each `it`
// block here must remain a real round-trip that exercises actual host APIs.
// Replacing any of these with mocks defeats their purpose.

describe("spine probe", () => {
  describe("HOME isolation round-trip (Skeptic risk #1)", () => {
    it("Env captures HOME at construction, not at every call", () => {
      // INVARIANT: createNodeEnv must snapshot the host env at construction so
      // mutations to process.env between construction and a step's read of
      // env.home cannot silently swap a sandbox HOME for a real USERPROFILE.
      const originalHome = process.env.HOME;
      const originalUP = process.env.USERPROFILE;
      const sandboxA = mkdtempSync(join(tmpdir(), "bankai-probe-home-A-"));
      const sandboxB = mkdtempSync(join(tmpdir(), "bankai-probe-home-B-"));
      try {
        process.env.HOME = sandboxA;
        process.env.USERPROFILE = sandboxA;
        const env = createNodeEnv();
        assert.equal(env.home, sandboxA, "Env.home must equal sandbox HOME at construction");

        process.env.HOME = sandboxB;
        process.env.USERPROFILE = sandboxB;
        assert.equal(env.home, sandboxA, "Env.home must remain frozen to construction-time HOME");
      } finally {
        if (originalHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = originalHome;
        }
        if (originalUP === undefined) {
          delete process.env.USERPROFILE;
        } else {
          process.env.USERPROFILE = originalUP;
        }
        rmSync(sandboxA, { recursive: true, force: true });
        rmSync(sandboxB, { recursive: true, force: true });
      }
    });

    it("Env.home points to a real existing directory", () => {
      const env = createNodeEnv();
      assert.ok(env.home, "Env.home must be defined and non-empty");
      assert.ok(existsSync(env.home), `Env.home must exist on disk: ${env.home}`);
    });
  });

  describe("headless spawn (Skeptic risk #2)", () => {
    it("spawns a long-lived child without shell wrapper or visible window", async () => {
      // INVARIANT: spawnHeadless must use child_process.spawn directly with
      // shell: false and windowsHide: true. Anything that goes through cmd.exe
      // /c, Start-Process, or shell: true breaks headless CI runs and leaks
      // orphan windows. The descriptor exposes its options for inspection so
      // this property is testable, not just structural.
      const child = spawnHeadless({
        command: process.execPath,
        args: ["-e", "setInterval(()=>{}, 1000); process.stdout.write('READY\\n')"],
      });

      try {
        assert.ok(child.pid, "child PID must be set");
        assert.equal(typeof child.pid, "number", "child PID must be a number");
        assert.equal(child.options.shell, false, "spawnHeadless must NOT use shell: true");
        assert.equal(child.options.windowsHide, true, "spawnHeadless must set windowsHide: true");

        const ready = await Promise.race([
          new Promise<string>((resolve) => {
            let buf = "";
            child.stdout.on("data", (chunk: Buffer) => {
              buf += chunk.toString("utf8");
              if (buf.includes("READY")) {
                resolve(buf);
              }
            });
          }),
          wait(5000).then(() => ""),
        ]);
        assert.match(ready, /READY/, "child must emit READY within 5s");
      } finally {
        const result = await child.kill();
        assert.equal(result.killed, true, "child must report killed=true after kill()");
      }
    });
  });

  describe("state.json atomic write + resume (Skeptic risk #3)", () => {
    it("writes and reads state atomically and survives a corrupted tmp sibling", async () => {
      // INVARIANT: writeAtomic must use a tmp-sibling + rename pattern so a
      // mid-write crash leaves the previous good state intact. A junk file at
      // the tmp path simulates an interrupted prior write. read() must ignore
      // it and return the last successfully renamed state.
      const dir = mkdtempSync(join(tmpdir(), "bankai-probe-state-"));
      try {
        const store = new FileStateStore<{ iter: number; status: string }>({ dir, name: "iteration" });

        await store.writeAtomic({ iter: 1, status: "ok" });
        const first = await store.read();
        assert.deepEqual(first, { iter: 1, status: "ok" }, "first read must match first write");

        await store.writeAtomic({ iter: 2, status: "ok" });
        const second = await store.read();
        assert.deepEqual(second, { iter: 2, status: "ok" }, "second read must reflect overwrite");

        const tmpPath = join(dir, "iteration.json.tmp");
        writeFileSync(tmpPath, "NOT_JSON_GARBAGE");
        const stillGood = await store.read();
        assert.deepEqual(stillGood, { iter: 2, status: "ok" }, "previous state must survive corrupted tmp");

        const raw = readFileSync(join(dir, "iteration.json"), "utf8");
        const parsed = JSON.parse(raw) as { iter: number };
        assert.equal(parsed.iter, 2, "on-disk state.json must be valid JSON");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("acquires and releases lock and refuses double acquisition", async () => {
      // INVARIANT: acquireLock must use O_EXCL semantics. Two concurrent CLI
      // runs against the same plan must not both believe they hold the lock.
      const dir = mkdtempSync(join(tmpdir(), "bankai-probe-lock-"));
      try {
        const store = new FileStateStore({ dir, name: "iteration" });
        await store.acquireLock();
        await assert.rejects(
          () => store.acquireLock(),
          /lock|EEXIST|busy/i,
          "second acquireLock must reject when lock is held",
        );
        await store.releaseLock();
        await store.acquireLock();
        await store.releaseLock();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
