// Step kind index. Importing this module triggers registration of every
// built-in step kind via the registry side effect on each step file.
// Adding a new step kind requires a new file in src/steps/ and a new
// import below.
//
// shell    -- spawn a short-lived process and capture stdout/stderr/exitCode
// tool     -- dispatch to a registered tool plugin (kash, future LLM, ...)
// assert   -- dispatch to a registered assertion plugin
// setup    -- invoke an environment plugin (noop, managed-process, ...)
// wait     -- poll readiness probes until all pass or timeout
// stop     -- terminate a registered handle by name
// run-plan -- execute another plan inline as a sub-step (composition)

import "./shell.js";
import "./tool.js";
import "./assert.js";
import "./setup.js";
import "./wait.js";
import "./stop.js";
import "./run-plan.js";
