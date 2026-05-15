// Tool plugin index. Importing this module triggers registration of every
// built-in tool plugin via the _registry side effect on each file. Adding a
// new tool plugin requires a new file in src/tools/ and a new import below.
//
// Tool plugins are an OPEN extension point. Step kinds and assertion kinds
// are closed. The boundary keeps tactical CLI knowledge (entrypoint discovery,
// retry policies, argv composition) inside bankai code, where it is testable
// and deterministic, instead of inside skill markdown where it would drift.

import "./kash.js";
