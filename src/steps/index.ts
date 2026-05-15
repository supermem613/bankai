// Step kind index. Importing this module triggers registration of every
// built-in step kind via the _registry side effect on each step file. Adding
// a new step kind requires a new file in src/steps/ and a new import below.
//
// shell  -- spawn a short-lived process and capture stdout/stderr/exitCode
// tool   -- dispatch to a registered tool plugin under src/tools/. Tools
//           are an OPEN registry. Add a tool by writing src/tools/<name>.ts
//           and importing it from src/tools/index.ts. The tool step kind
//           itself is closed; only the tool plugins it dispatches to grow.

import "./shell.js";
import "./tool.js";
