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
  ready/done booleans, and log paths.
- `logs` - read detailed run and transcript log tails for registered handles.
- `stop` - stop a registered handle by name. Attached processes use the
  Ctrl+C control path and verify tracked processes exit before clearing state.
- `doctor` - run health checks, validate an optional plan, and prune stale
  registry state with `--prune`.
- `update` - self-update this Bankai git checkout with `git pull --ff-only`,
  dependency install, and rebuild when changes arrive.
- `schema` - print the Bankai command surface by default. Use `schema plan` or
  `schema bindings` for plan-authoring internals.

Bankai emits JSON envelopes by default. `--json` remains accepted as a
deprecated compatibility no-op.

## Agentic contract

See [`docs/AGENTIC_CONTRACT.md`](docs/AGENTIC_CONTRACT.md) for the stdout,
stderr, schema, status, logs, and stop lifecycle contract agents should rely on.

## Bundled skills

Bankai ships thin agent routers under `.claude/skills/`:

- `dev-loop` starts, inspects, logs, and stops long-running dev loops through
  Bankai plans.
- `test` runs Bankai test plans and reports pass/fail from the envelope.
- `create-bankai-skill` helps agents create new skills that delegate execution
  to Bankai instead of embedding orchestration logic in skill prose.

The bundled skills are examples of the intended pattern: the skill routes and
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
  dev-loop/
  test/
test/
  run.mjs             # Cross-platform test runner (HOME-sandboxed)
  tsconfig.json       # Test type-check config
  unit/               # Unit tests (*.test.ts)
  integration/        # Integration tests (*.test.ts)
```

## License

MIT
