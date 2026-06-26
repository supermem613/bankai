# bankai

> Agentic-first orchestration engine for reliable dev-loop, test, and tool workflows

Bankai runs schema-validated plans for agents and humans. It gives long-running
dev servers a stable handle, readiness proof, concise status, detailed logs, and
verified teardown. It also runs short-lived test and tool workflows with one
JSON envelope for success, failure, timing, and logs.

## Questions and tasks it can handle

### Dev loops

- *"Start the local API dev server and wait until it is actually ready"*
- *"Start this workflow in a visible terminal, then return only when the
  readiness line appears and the expected ports respond"*
- *"Show whether the dev server is ready, still starting, failed, or already
  stopped"*
- *"Stop the dev server with its normal Ctrl+C lifecycle and verify no tracked
  child processes are left behind"*
- *"Show me the detailed logs for the running dev loop without flooding status"*

### Test and validation plans

- *"Run the smoke test plan and give me the failing step if anything breaks"*
- *"Run this external CLI, capture its JSON output, and assert the response
  contains the expected text"*
- *"Write a prompt file into the run output folder, pass it to a CLI, and assert
  the JSON artifact it produced"*
- *"Validate this plan before running it so typos in step kinds or readiness
  probes fail up front"*
- *"Compose a setup plan and a test plan while preserving one envelope for the
  full run"*

### Agent workflow automation

- *"Give this agent one command that starts the server, waits for readiness, and
  returns the handle it can later stop"*
- *"Use a machine-readable bindings file instead of hardcoded local paths"*
- *"Show me the Bankai command schema so I know what an agent can call"*
- *"Tell me the plan schema so I can generate a valid Bankai plan"*
- *"Prune stale runtime handles before starting a new loop"*
- *"Return structured failure details that an agent can route on without parsing
  terminal prose"*
- *"Update this Bankai checkout and rebuild only if new changes arrived"*

## Quick start

```bash
git clone https://github.com/supermem613/bankai.git ~/repos/bankai
cd ~/repos/bankai
npm install
npm run build
npm link    # makes `bankai` available globally
```

## Commands

- `run` - execute a plan. Attached dev-loop plans return after readiness or
  failure and include the registered handle summary in `registry`.
- `status` - show concise registered-handle state: alive, phase, current step,
  ready/done booleans, latest fatal/progress detail, and log paths.
- `logs` - read detailed run and transcript log tails for registered handles.
- `stop` - stop a registered handle by name. Attached processes use the
  Ctrl+C control path and verify tracked processes exit before clearing state.
  Managed processes with a `stop` config use the declared stdin strategy first,
  then escalate to process-tree termination on timeout.
- `doctor` - run health checks, validate an optional plan, and prune stale
  registry state with `--prune`.
- `update` - self-update this Bankai git checkout with `git pull --ff-only`,
  dependency install, and rebuild when changes arrive.
- `schema` - print the Bankai command surface by default. Use `schema plan` or
  `schema bindings` for plan-authoring internals.

Bankai emits JSON envelopes by default.

## Plan primitives for CLI tests

Plans can drive arbitrary CLIs with generic steps instead of product-specific
workflow code:

- `shell` runs a command with schema-checked args. Args can reference bindings
  with `{ "binding": "name" }`, bound paths with `{ "binding": "name",
  "path": "file.json" }`, or string templates like `{{bankaiRunId}}`.
  Optional arg groups use `{ "id": "spfx", "skipIfAbsent": "bindingName",
  "args": ["--flag", { "binding": "bindingName" }] }` to omit a flag-plus-value
  pair when an optional binding is absent.
- `write-file` writes bounded UTF-8 text to a relative path or bound path.
  Content can use the same `{{bindingName}}` templates.
- `assert-json` reads a JSON file and checks path existence, scalar equality,
  text contains/not-contains, regex, or array object membership.
- `assert-text` reads a text file and checks contains/not-contains/regex.
- `alwaysRun` can be set on cleanup steps so they still execute after an
  earlier step fails.
- Steps can set `runIf` or `skipIf` with binding conditions such as
  `{ "binding": "mode", "equals": "alTest" }` or
  `{ "binding": "spfxDevServerUrl", "present": true }`.

`bankai run` injects reserved automatic bindings for generated artifacts:
`bankaiRunId`, `bankaiLogFile`, `bankaiOutputDir`, `bankaiPlanDir`, and
`bankaiWorkDir`.

Runtime bindings can be supplied as the original array shape:

```bash
bankai run plan.json --bindings-json '[{"key":"workspace","value":"C:\\repo"}]'
```

or as object shorthand:

```bash
bankai run plan.json --bindings-json '{"workspace":"C:\\repo"}'
```

`attached-process` steps that set `announceReady` (the default) get their
ready event written to
`<home>/.bankai/out/agents/<registerAs-or-planName>/ready.json`. The path is
bankai-managed and not configurable; the workspace stays free of `.bankai/`
artifacts.

When Bankai opens a visible terminal for an attached process, the parent run
waits for the child readiness event. Validation failures before the child
process launches are reported through that event and exit nonzero immediately.
While a long startup is still healthy, the parent emits periodic waiting
messages and relays recognized child progress such as `sync [X/Y]`.

## Managed-process graceful stdin stop

Interactive dev servers that require specific stdin input to exit gracefully
(e.g., pressing `q` to quit) can declare a `stop` strategy in their
managed-process config:

```json
{
  "id": "dev-server",
  "kind": "setup",
  "env": "managed-process",
  "registerAs": "my-server",
  "config": {
    "command": "my-dev-server",
    "args": ["--port", "3000"],
    "cwd": ".",
    "logFile": "logs/server.log",
    "stop": {
      "kind": "stdin",
      "input": "q\n",
      "graceMs": 10000
    }
  }
}
```

When `bankai stop my-server` or a `stop` step targets this handle:

1. Bankai writes the configured `input` to the process stdin via a
   cross-platform relay mechanism (works on Linux, macOS, and Windows).
2. It waits up to `graceMs` (default: 5000ms) for the process to exit.
3. If the process exits within the grace period, stop succeeds without
   escalation.
4. If the process does not exit in time, Bankai falls back to
   process-tree termination (SIGTERM/SIGKILL on POSIX, taskkill on
   Windows) and reports the escalation in the envelope.

When `stop` is omitted, the existing behavior is preserved: processes are
terminated immediately via the process tree.

## Agentic contract

See [`docs/AGENTIC_CONTRACT.md`](docs/AGENTIC_CONTRACT.md) for the stdout,
stderr, schema, status, logs, and stop lifecycle contract agents should rely on.

## Bundled skills

Bankai ships a thin agent router under `.claude/skills/`:

- `create-bankai-skill` helps agents create new skills that delegate execution
  to Bankai instead of embedding orchestration logic in skill prose.

The bundled skill is an example of the intended pattern: the skill routes and
explains, while Bankai owns process lifecycle, readiness, retries, logs,
assertions, and JSON envelopes.

## Conventions

- **Lean deps.** Runtime deps stay small (currently 3: chalk, commander, zod).
  Add a runtime dep only with a clear reason — every dep is supply-chain risk.
- **`doctor` first.** Every CLI ships a `doctor` command that returns
  `CheckResult[]` (name, ok, detail, hint). Hints carry remediation text.
- **JSON envelopes everywhere.** Commands that produce output emit structured
  JSON by default.
- **Plan → preview → confirm → apply** for any command that mutates state on
  disk or remote. Silent auto-apply is an anti-pattern.

## Development

```bash
npm run build               # lint + test type-check -> tsc -> dist/
npm run lint                # type-check (src + test)
npm test                    # all tests
npm run test:unit           # unit only
npm run test:integration    # integration only
npm run clean               # remove dist/
```

CI runs on Ubuntu + Windows via GitHub Actions (`.github/workflows/ci.yml`).

## Project structure

```
src/
  cli.ts              # Entry point — Commander.js program
  commands/           # One file per CLI command
docs/
  AGENTIC_CONTRACT.md # Agent-facing CLI contract
.claude/skills/
  create-bankai-skill/
test/
  run.mjs             # Cross-platform test runner (HOME-sandboxed)
  tsconfig.json       # Test type-check config
  unit/               # Unit tests (*.test.ts)
  integration/        # Integration tests (*.test.ts)
```

## License

MIT
