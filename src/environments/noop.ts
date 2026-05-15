import { z } from "zod";
import type { EnvironmentPlugin } from "./interface.js";
import { registerEnvironment } from "./registry.js";

// Noop environment plugin: the default kind for scenarios that need nothing
// beyond shell steps and assertions. It exists for two reasons.
//   1. It is the dispatch-path canary. If the orchestrator can run a noop
//      scenario end-to-end then the plugin contract is wired correctly.
//   2. It is the implicit default when a scenario omits the environment
//      field, so the simplest test scenarios stay simple.
// Capabilities are intentionally empty. A step that wants ports or endpoints
// needs a real environment plugin like augloop.

const NoopConfigSchema = z.object({}).passthrough();

export interface NoopCapabilities {
  ready: true;
}

export const noopPlugin: EnvironmentPlugin<typeof NoopConfigSchema, NoopCapabilities> = {
  kind: "noop",
  configSchema: NoopConfigSchema,
  async doctor() {
    return [
      {
        name: "noop",
        ok: true,
        detail: "noop environment requires nothing",
      },
    ];
  },
  async setup() {
    return {
      capabilities: { ready: true },
      async teardown() {},
    };
  },
};

registerEnvironment(noopPlugin);
