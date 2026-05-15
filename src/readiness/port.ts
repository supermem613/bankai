import { z } from "zod";
import { connect } from "node:net";
import type { ReadinessProbe, ReadinessContext, ReadinessOutcome } from "./interface.js";

// TCP connect probe. Ready iff a TCP connection to host:port can be
// opened within timeoutMs. We connect-then-close immediately. Some
// servers log noise on incomplete handshake, but accepting is what the
// dev loop is waiting for; once accept happens we know the listener is
// up.
//
// IPv6 / dual-stack: we let node pass the host string straight to
// connect, which respects the underlying resolver. Specifying 127.0.0.1
// or ::1 explicitly avoids DNS in the hot path.

export const PortReadinessProbeConfigSchema = z.object({
  kind: z.literal("port"),
  id: z.string().min(1),
  host: z.string().min(1).default("127.0.0.1"),
  port: z.number().int().min(1).max(65535),
  timeoutMs: z.number().int().positive().default(2000),
});

export type PortReadinessProbeConfig = z.infer<typeof PortReadinessProbeConfigSchema>;

async function tryConnect(host: string, port: number, timeoutMs: number, signal: AbortSignal): Promise<ReadinessOutcome> {
  return new Promise<ReadinessOutcome>((resolve) => {
    const socket = connect({ host, port });
    const cleanup = (): void => {
      socket.removeAllListeners();
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    };
    const onAbort = (): void => {
      cleanup();
      resolve({ ok: false, detail: `aborted while connecting to ${host}:${port}` });
    };
    if (signal.aborted) {
      cleanup();
      resolve({ ok: false, detail: `aborted before connect to ${host}:${port}` });
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      cleanup();
      resolve({ ok: false, detail: `connect to ${host}:${port} timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      cleanup();
      resolve({ ok: true, detail: `connected to ${host}:${port}` });
    });
    socket.once("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      cleanup();
      resolve({ ok: false, detail: `connect to ${host}:${port} failed: ${err.code ?? err.message}` });
    });
  });
}

export const portReadinessProbe: ReadinessProbe<typeof PortReadinessProbeConfigSchema> = {
  kind: "port",
  configSchema: PortReadinessProbeConfigSchema,
  async evaluate(ctx: ReadinessContext, config: PortReadinessProbeConfig): Promise<ReadinessOutcome> {
    return tryConnect(config.host, config.port, config.timeoutMs, ctx.signal);
  },
};
