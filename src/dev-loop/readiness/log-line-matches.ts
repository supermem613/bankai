import { z } from "zod";
import { open } from "node:fs/promises";
import type { ReadinessProbe, ReadinessContext, ReadinessOutcome } from "./interface.js";

// Log-line-matches probe. Ready iff a regex finds at least one match in
// the dev-server log file, scanned from the persisted logStartOffset.
//
// Why scan from logStartOffset rather than from the start of the file:
// dev-loop reuses the log file across restarts. If we matched from byte
// 0 we would falsely fire on a "Listening on 8080" line written by a
// previous run. The state file's logStartOffset marks the byte where
// the current run started writing.
//
// Why cap at maxBytes: a long-running dev server can produce gigabytes
// of log output. Loading all of it into memory on every poll is a
// pathological hot loop. We only need the tail. We read at most
// maxBytes from the END of the relevant region, scan line by line, and
// return on first match.
//
// Why line-by-line: a regex like /Listening on \d+/ should match a
// complete line, not a fragment that happens to span a chunk boundary.
// Reading one chunk and then iterating over split-on-newline guarantees
// each candidate is a complete line.

export const LogLineMatchesProbeConfigSchema = z.object({
  kind: z.literal("log-line-matches"),
  id: z.string().min(1),
  pattern: z.string().min(1),
  flags: z.string().default(""),
  maxBytes: z.number().int().positive().default(1_048_576),
});

export type LogLineMatchesProbeConfig = z.infer<typeof LogLineMatchesProbeConfigSchema>;

interface LogTail {
  text: string;
  startOffset: number;
  endOffset: number;
}

async function readTailFromOffset(filePath: string, offset: number, maxBytes: number): Promise<LogTail | undefined> {
  let fh;
  try {
    fh = await open(filePath, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
  try {
    const stat = await fh.stat();
    const size = stat.size;
    if (size <= offset) {
      return { text: "", startOffset: offset, endOffset: size };
    }
    const available = size - offset;
    const readSize = Math.min(available, maxBytes);
    const startOffset = available > maxBytes ? size - maxBytes : offset;
    const buf = Buffer.alloc(readSize);
    await fh.read(buf, 0, readSize, startOffset);
    return { text: buf.toString("utf8"), startOffset, endOffset: size };
  } finally {
    await fh.close();
  }
}

export const logLineMatchesProbe: ReadinessProbe<typeof LogLineMatchesProbeConfigSchema> = {
  kind: "log-line-matches",
  configSchema: LogLineMatchesProbeConfigSchema,
  async evaluate(ctx: ReadinessContext, config: LogLineMatchesProbeConfig): Promise<ReadinessOutcome> {
    const { state } = ctx;
    let regex: RegExp;
    try {
      regex = new RegExp(config.pattern, config.flags);
    } catch (err) {
      return { ok: false, detail: `invalid regex /${config.pattern}/${config.flags}: ${(err as Error).message}` };
    }
    const tail = await readTailFromOffset(state.logFile, state.logStartOffset, config.maxBytes);
    if (!tail) {
      return { ok: false, detail: `log file ${state.logFile} not found yet` };
    }
    if (tail.text.length === 0) {
      return { ok: false, detail: `log file ${state.logFile} has no new bytes since logStartOffset ${state.logStartOffset}` };
    }
    const lines = tail.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        return {
          ok: true,
          detail: `pattern matched line ${i + 1} of ${lines.length} in log tail (${tail.endOffset - tail.startOffset} bytes scanned)`,
        };
      }
    }
    return {
      ok: false,
      detail: `pattern did not match any of ${lines.length} log lines (${tail.endOffset - tail.startOffset} bytes scanned)`,
    };
  },
};
