import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { createNodeEnv } from "../../src/env-runtime/env.js";
import { defaultReadyEventFile } from "../../src/steps/attached-process.js";

// The default-ready-file helper is intentionally pure: any string in (the
// register name) and a synthesized Env in, an absolute path out. Tests
// pin the on-disk shape because every plan that omits readyEventFile now
// depends on it.
describe("attached-process: defaultReadyEventFile", () => {
  it("places the ready file under <env.home>/.bankai/out/agents/<name>/ready.json", () => {
    const env = { ...createNodeEnv(), home: "/h" };
    const got = defaultReadyEventFile(env, "augloop-workflows");
    assert.equal(got, join("/h", ".bankai", "out", "agents", "augloop-workflows", "ready.json"));
  });

  it("isolates distinct register names into distinct directories", () => {
    const env = { ...createNodeEnv(), home: "/h" };
    const a = defaultReadyEventFile(env, "svc-a");
    const b = defaultReadyEventFile(env, "svc-b");
    assert.notEqual(a, b);
    assert.ok(a.endsWith(join("agents", "svc-a", "ready.json")), a);
    assert.ok(b.endsWith(join("agents", "svc-b", "ready.json")), b);
  });

  it("uses env.home as the root rather than process.env", () => {
    const env1 = { ...createNodeEnv(), home: "/home1" };
    const env2 = { ...createNodeEnv(), home: "/home2" };
    assert.notEqual(
      defaultReadyEventFile(env1, "svc"),
      defaultReadyEventFile(env2, "svc"),
    );
  });
});
