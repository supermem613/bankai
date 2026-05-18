import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { runDoctorCommand } from "../../src/commands/doctor.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createNodeEnv } from "../../src/env-runtime/env.js";
import { createRegistryStore } from "../../src/registry/store.js";
import { tmpdir } from "node:os";

import "../../src/steps/index.js";
import "../../src/assertions/index.js";
import "../../src/environments/index.js";
import "../../src/tools/index.js";
import "../../src/readiness/index.js";

describe("doctor", () => {
  it("runs base checks and reports node version and step registry", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bankai-doctor-"));
    try {
      const envelope = await runDoctorCommand({ logDir: join(tmp, "logs"), repoRoot: tmp });
      assert.equal(envelope.command, "doctor");
      assert.ok(envelope.checks);
      const names = envelope.checks!.map((c) => c.name);
      assert.ok(names.includes("node-version"));
      assert.ok(names.includes("step-registry"));
      assert.ok(names.some((n) => n.startsWith("env:noop:")));
      assert.ok(names.some((n) => n.startsWith("env:managed-process:")));
      assert.ok(names.includes("registry-lock"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("prunes stale runtime state entries", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bankai-doctor-prune-"));
    try {
      const env = createNodeEnv();
      const store = createRegistryStore({ env });
      await store.putEntry({
        name: "stale-handle",
        planName: "stale-plan",
        planPath: join(tmp, "stale.plan.json"),
        cwd: tmp,
        registeredAt: env.clock.isoNow(),
        pid: 999999,
        command: "missing",
        args: [],
        workDir: tmp,
        envKind: "managed-process",
        logFile: join(tmp, "missing.log"),
        logStartOffset: 0,
      });
      const before = await store.read();
      assert.ok(before.entries["stale-handle"]);

      const envelope = await runDoctorCommand({
        env,
        prune: true,
        logDir: join(tmp, "logs"),
        repoRoot: tmp,
      });

      assert.equal(envelope.ok, true, JSON.stringify(envelope.failure));
      assert.ok(envelope.checks?.some((c) => c.name === "registry-prune" && c.ok));
      const after = await store.read();
      assert.equal(after.entries["stale-handle"], undefined);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
