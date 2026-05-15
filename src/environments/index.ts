// Side-effect imports register the built-in environment plugins.
// Adding a new plugin requires a new file under src/environments and a line
// here. There is intentionally no runtime discovery so the registered set is
// auditable from this file alone.
import "./noop.js";
import "./managed-process.js";
