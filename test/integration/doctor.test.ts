import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { runDoctorCommand } from "../../src/commands/doctor.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
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
      assert.ok(names.some((n) => n.startsWith("tool:kash:")));
      assert.ok(names.includes("registry-lock"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
