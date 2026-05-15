import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { createNodeEnv } from "../../src/env-runtime/env.js";
import {
  registerReadinessProbe,
  unregisterReadinessProbeForTesting,
  listReadinessProbes,
  getReadinessProbe,
} from "../../src/dev-loop/readiness/registry.js";
import { evaluateReadiness } from "../../src/dev-loop/readiness/evaluate.js";
import "../../src/dev-loop/readiness/index.js";
import type { DevLoopStateEntry } from "../../src/dev-loop/envelope.js";
import type { ReadinessProbe } from "../../src/dev-loop/readiness/interface.js";

function dummyState(): DevLoopStateEntry {
  return {
    schemaVersion: "1",
    planName: "x",
    startedAt: "2024-01-01T00:00:00.000Z",
    pid: 1,
    fingerprint: { creationTime: "x", commandLine: "y" },
    workDir: "/tmp",
    command: "node",
    args: [],
    logFile: "/tmp/x.log",
    logStartOffset: 0,
    envKind: "managed-process",
  };
}

test("registry: built-in probes are registered after import", () => {
  const kinds = listReadinessProbes();
  assert.ok(kinds.includes("port"));
  assert.ok(kinds.includes("log-line-matches"));
  assert.deepEqual(kinds, [...kinds].sort());
});

test("registry: register rejects duplicate kinds", () => {
  const kind = "test-dup-" + Math.random().toString(36).slice(2, 8);
  const probe: ReadinessProbe = {
    kind,
    configSchema: z.object({ kind: z.literal(kind), id: z.string() }),
    async evaluate() {
      return { ok: true, detail: "" };
    },
  };
  registerReadinessProbe(probe);
  try {
    assert.equal(getReadinessProbe(kind), probe);
    assert.throws(() => registerReadinessProbe(probe), /already registered/);
  } finally {
    unregisterReadinessProbeForTesting(kind);
  }
});

test("evaluate: allReady=true when every ref's probe returns ok", async () => {
  const kind1 = "stub-ok-1-" + Math.random().toString(36).slice(2, 8);
  const kind2 = "stub-ok-2-" + Math.random().toString(36).slice(2, 8);
  registerReadinessProbe({
    kind: kind1,
    configSchema: z.object({ kind: z.literal(kind1), id: z.string() }),
    async evaluate() {
      return { ok: true, detail: "ok-1" };
    },
  });
  registerReadinessProbe({
    kind: kind2,
    configSchema: z.object({ kind: z.literal(kind2), id: z.string() }),
    async evaluate() {
      return { ok: true, detail: "ok-2" };
    },
  });
  try {
    const env = createNodeEnv();
    const ctrl = new AbortController();
    const r = await evaluateReadiness({
      env,
      state: dummyState(),
      signal: ctrl.signal,
      refs: [
        { kind: kind1, id: "a" },
        { kind: kind2, id: "b" },
      ],
    });
    assert.equal(r.allReady, true);
    assert.equal(r.observations.length, 2);
    assert.ok(r.observations.every((o) => typeof o.checkedAt === "string" && o.checkedAt.length > 0));
  } finally {
    unregisterReadinessProbeForTesting(kind1);
    unregisterReadinessProbeForTesting(kind2);
  }
});

test("evaluate: allReady=false when any ref's probe fails", async () => {
  const kind = "stub-mixed-" + Math.random().toString(36).slice(2, 8);
  registerReadinessProbe({
    kind,
    configSchema: z.object({ kind: z.literal(kind), id: z.string() }),
    async evaluate() {
      return { ok: false, detail: "not yet" };
    },
  });
  try {
    const env = createNodeEnv();
    const ctrl = new AbortController();
    const r = await evaluateReadiness({
      env,
      state: dummyState(),
      signal: ctrl.signal,
      refs: [{ kind, id: "a" }],
    });
    assert.equal(r.allReady, false);
    assert.equal(r.observations[0].ok, false);
    assert.equal(r.observations[0].detail, "not yet");
  } finally {
    unregisterReadinessProbeForTesting(kind);
  }
});

test("evaluate: unknown kind becomes a non-throwing failed observation", async () => {
  const env = createNodeEnv();
  const ctrl = new AbortController();
  const r = await evaluateReadiness({
    env,
    state: dummyState(),
    signal: ctrl.signal,
    refs: [{ kind: "definitely-not-a-real-kind", id: "z" }],
  });
  assert.equal(r.allReady, false);
  assert.equal(r.observations.length, 1);
  assert.match(r.observations[0].detail, /unknown readiness probe/);
});

test("evaluate: schema mismatch becomes a failed observation, not a throw", async () => {
  const kind = "stub-schema-" + Math.random().toString(36).slice(2, 8);
  registerReadinessProbe({
    kind,
    configSchema: z.object({
      kind: z.literal(kind),
      id: z.string(),
      requiredField: z.number(),
    }),
    async evaluate() {
      return { ok: true, detail: "" };
    },
  });
  try {
    const env = createNodeEnv();
    const ctrl = new AbortController();
    const r = await evaluateReadiness({
      env,
      state: dummyState(),
      signal: ctrl.signal,
      refs: [{ kind, id: "a" }],
    });
    assert.equal(r.allReady, false);
    assert.equal(r.observations[0].ok, false);
    assert.match(r.observations[0].detail, /config invalid/);
  } finally {
    unregisterReadinessProbeForTesting(kind);
  }
});

test("evaluate: probe that throws becomes a failed observation", async () => {
  const kind = "stub-throw-" + Math.random().toString(36).slice(2, 8);
  registerReadinessProbe({
    kind,
    configSchema: z.object({ kind: z.literal(kind), id: z.string() }),
    async evaluate() {
      throw new Error("kaboom");
    },
  });
  try {
    const env = createNodeEnv();
    const ctrl = new AbortController();
    const r = await evaluateReadiness({
      env,
      state: dummyState(),
      signal: ctrl.signal,
      refs: [{ kind, id: "a" }],
    });
    assert.equal(r.allReady, false);
    assert.match(r.observations[0].detail, /probe threw: kaboom/);
  } finally {
    unregisterReadinessProbeForTesting(kind);
  }
});

test("evaluate: empty refs => allReady=false (refuses vacuous ready)", async () => {
  const env = createNodeEnv();
  const ctrl = new AbortController();
  const r = await evaluateReadiness({
    env,
    state: dummyState(),
    signal: ctrl.signal,
    refs: [],
  });
  assert.equal(r.allReady, false);
  assert.equal(r.observations.length, 0);
});
