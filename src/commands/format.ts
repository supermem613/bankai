import { writeFileSync } from "node:fs";
import type { BankaiEnvelope } from "../plan/envelope.js";

// Shared envelope formatter used by every bankai command. Defaults to
// JSON for machine consumption. Pretty mode (--pretty) emits a brief
// human summary for terminal use. Always prints the log file path so
// the user can re-read the full event stream.

export interface FormatOptions {
  json?: boolean;
  pretty?: boolean;
  out?: string;
}

export function emitEnvelope(opts: FormatOptions, envelope: BankaiEnvelope): void {
  const json = JSON.stringify(envelope, null, 2);
  if (opts.out) {
    writeFileSync(opts.out, json + "\n", "utf8");
  }
  if (opts.pretty && !opts.json) {
    printPretty(envelope);
  } else {
    process.stdout.write(json + "\n");
  }
}

function printPretty(env: BankaiEnvelope): void {
  const status = env.ok ? "OK" : "FAIL";
  const head = `[${status}] ${env.command}${env.planName ? ` ${env.planName}` : ""} in ${env.durationMs}ms`;
  process.stdout.write(head + "\n");
  for (const s of env.steps) {
    const mark = s.ok ? "ok" : "X";
    const err = s.ok ? "" : ` -- ${s.error ?? "unknown"}`;
    process.stdout.write(`  [${mark}] ${s.id} (${s.kind}) ${s.durationMs}ms${err}\n`);
  }
  if (env.checks) {
    for (const c of env.checks) {
      const mark = c.ok ? "ok" : "X";
      process.stdout.write(`  [${mark}] check ${c.name}: ${c.detail}${c.hint ? ` -- ${c.hint}` : ""}\n`);
    }
  }
  if (env.registry) {
    if (env.registry.length === 0) {
      process.stdout.write(`  registry: (empty)\n`);
    }
    for (const r of env.registry as Array<Record<string, unknown>>) {
      const name = r["name"] as string | undefined;
      const planName = r["planName"] as string | undefined;
      const pid = r["pid"] as number | undefined;
      const alive = r["alive"] as boolean | undefined;
      const aliveStr = alive === undefined ? "" : alive ? " alive" : " DEAD";
      process.stdout.write(`  - ${name ?? "?"} pid=${pid ?? "?"} plan=${planName ?? "?"}${aliveStr}\n`);
    }
  }
  if (env.failure) {
    process.stdout.write(`failure: ${env.failure.stage} ${env.failure.reason}\n`);
  }
  if (env.logFile) {
    process.stdout.write(`log: ${env.logFile}\n`);
  }
}
