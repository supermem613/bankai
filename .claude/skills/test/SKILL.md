---
name: test
description: |
  Trial replacement for ~/.copilot/skills/test/. Drives bankai test run
  against a scenario file under .bankai/plans/. Use when the user says
  "/test <name>", "run the test plan", or "test <name>". The legacy
  ~/.copilot/skills/test/ remains the active version until this trial proves
  out across enough scenarios. Iterate the skill text inside this repo.
metadata:
  userInvocable: true
  trial: true
---

# test (bankai trial)

## Prime Directive

`bankai test run <scenario.json>` is the only orchestration entry point.
A scenario is a self-contained, schema-validated JSON file. The agent's job
is to pick the right scenario and read the envelope.  No PowerShell wrapper
loops, no improvised health checks, no assert-via-grep glue.

## When to run

- `/test <name>` or `test <name>`
- "run the <name> test plan", "verify <name> end-to-end"
- Validation after a code change in a known-tested area

Do not run for unit tests (`yarn test`, `npm test`) or design questions.

## Execution

### 1. Resolve the scenario file

By convention, scenario files live at `<repo>/.bankai/plans/<name>.test.json`.
List them with PowerShell or `Get-ChildItem`. If the name is ambiguous, ask
which scenario the user means before running.

### 2. Run the scenario

```powershell
bankai test run <repo>/.bankai/plans/<name>.test.json --json | ConvertFrom-Json
```

`--json` keeps the output machine-parseable. The exit code is the truth: 0 on
pass, 1 on any failure.

### 3. Read the envelope

The envelope is documented in `src/schema/envelope.ts`. The fields that
matter for routing the next step:

- `ok` — boolean. AND of every step ok and every assertion ok.
- `failure.stage` — `validation` | `env-setup` | `step` | `assertion` |
  `env-teardown`. Tells you which phase aborted.
- `failure.id` — the offending step or assertion id.
- `failure.reason` — human-readable cause.
- `steps[].stdout` and `steps[].stderr` — captured for triage.

## Authoring a new scenario

The schema is defined in `src/schema/scenario.ts`. The contract:

- `schemaVersion: "1"` is required and is the discriminator for forward
  compatibility.
- `name` is the scenario id used in the envelope.
- `environment.kind` defaults to `"noop"`. Real environments are added by
  registering an EnvironmentPlugin under `src/environments/`.
- `steps` and `assertions` are arrays of typed refs. Each ref's `kind` must
  match a registered handler under `src/steps/` or `src/assertions/`.

Closed step kinds today: `shell`. More kinds are added by writing a new file
under `src/steps/` and importing it from `src/steps/index.ts`.

Closed assertion kinds today: `step-output-contains`. Same extension story
under `src/assertions/`.

## What this trial replaces

- `~/.copilot/skills/test/scripts/test-cli.mjs` (367 lines of ad-hoc routing,
  kash capture, telemetry parsing). Bankai handles the orchestration via
  typed schemas and closed handler registries.
- The PowerShell-wrapper-per-scenario pattern. Each scenario is now one JSON
  file the engine validates before running.

The legacy skill at `~/.copilot/skills/test/` remains authoritative until
this trial covers all the scenarios the legacy one covers.
