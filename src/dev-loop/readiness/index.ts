import { logLineMatchesProbe } from "./log-line-matches.js";
import { portReadinessProbe } from "./port.js";
import { registerReadinessProbe } from "./registry.js";

// One-time registration of built-in readiness probes. Importing this
// module triggers registration as a side effect, mirroring the
// environments and tools index modules. The orchestrator imports this
// once at startup so plans referencing the built-in kinds resolve.

registerReadinessProbe(portReadinessProbe);
registerReadinessProbe(logLineMatchesProbe);
