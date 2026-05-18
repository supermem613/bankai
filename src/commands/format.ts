import { writeFileSync } from "node:fs";
import type { BankaiEnvelope } from "../plan/envelope.js";

export interface FormatOptions {
  json?: boolean;
  out?: string;
}

export function emitEnvelope(opts: FormatOptions, envelope: BankaiEnvelope): void {
  const json = JSON.stringify(envelope, null, 2);
  if (opts.out) {
    writeFileSync(opts.out, json + "\n", "utf8");
  }
  process.stdout.write(json + "\n");
}
