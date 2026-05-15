---
name: test
description: |
  Run end-to-end test plans against any repo using the bankai test orchestrator.
  Each plan is a self-contained, schema-validated JSON file under
  <repo>/.bankai/plans/<name>.test.json. Bankai validates the plan, runs every
  step, evaluates every assertion, and returns a single JSON envelope. Use when
  the user says "/test <name>", "test <name>", "run the <name> test plan", or
  "verify <name> end-to-end". Repo-agnostic.
metadata:
  userInvocable: true
---

# test

## Prime directive

`bankai test run <plan.json>` is the only orchestration entry point. A plan is
a self-contained, schema-validated JSON file. Your job is to pick the right
plan, run bankai, parse the envelope, and report the result.

No PowerShell wrapper loops. No improvised `Get-Process` health checks. No
assert-via-grep glue. If a plan needs a step kind that bankai does not have
yet, add the step kind to bankai under `src/steps/`. Do NOT smuggle
orchestration logic into the plan itself or into this skill text.

## When to run

- `/test <name>` or `test <name>`
- "run the <name> test plan", "verify <name> end-to-end"
- Validation after a code change in a known-tested area, when the user names a
  plan or a clear plan name can be inferred

Do NOT run for unit tests (`yarn test`, `npm test`) or pure design questions.

## Execution

### 1. Resolve the plan file

Plans live at `<repo>/.bankai/plans/<name>.test.json`. The repo root is the
working directory when you were invoked, unless the user said otherwise.

```powershell
Get-ChildItem -Path .bankai\plans -Filter *.test.json -Recurse |
  Select-Object -ExpandProperty FullName
```

If the user-supplied name does not exactly match a file, prefer the closest
suffix match. Ask if more than one matches.

### 2. Run the plan

```powershell
bankai test run .bankai\plans\<name>.test.json --json
```

Stdout is the envelope JSON. The exit code is the truth: `0` on pass, `1` on
any failure (validation, env setup, step, assertion, env teardown).

If `bankai` is not on PATH, fall back to:

```powershell
node $env:USERPROFILE\repos\bankai\src\cli.ts test run .bankai\plans\<name>.test.json --json
```

### 3. Read the envelope

The envelope contract is defined in
`<bankai>/src/schema/envelope.ts`. Fields that drive the next step:

- `ok` — boolean. AND of every step ok and every assertion ok.
- `failure.stage` — `validation | env-setup | step | assertion | env-teardown`.
  Tells you which phase aborted.
- `failure.id` — the offending step or assertion id.
- `failure.reason` — human-readable cause.
- `steps[]` — each has `id`, `kind`, `ok`, `durationMs`, `exitCode?`,
  `stdout?`, `stderr?`, `error?`. Stop reading after the first `ok: false`
  step; later steps were skipped.
- `assertions[]` — each has `id`, `kind`, `ok`, `detail`. Only present when
  every step passed. If `failure.stage` is `step` then `assertions` is `[]`
  by design.

### 4. Report the result

Always end with a one-line headline plus, on failure, the failing id and
reason verbatim from `failure.reason`. On pass, the headline is enough.

```text
PASS  scenario "skills-smoke" (5 steps, 8 assertions, 2.4s)
FAIL  scenario "skills-smoke" — assertion "site-tools-bound" — file ".bankai/out/tools.txt" does NOT contain "list_items"
```

## Plan shape (canonical)

Every plan is a JSON file matching this shape. The full schema lives in
`<bankai>/src/schema/scenario.ts`. Source of truth is the schema; this
section is a quick reference.

```jsonc
{
  "schemaVersion": "1",
  "name": "skills-smoke",
  "description": "Optional human-readable summary",
  "environment": {
    "kind": "noop",
    "config": {},
    "setupTimeoutMs": 30000
  },
  "steps": [
    /* step refs, executed in order, stop on first failure */
  ],
  "assertions": [
    /* assertion refs. Only evaluated if every step passed.
       If any step fails, assertions are skipped entirely. */
  ]
}
```

### Step kinds (closed)

#### `shell`

Run a short-lived command, capture stdout, stderr, exit code.

```jsonc
{
  "kind": "shell",
  "id": "build",
  "command": "yarn",
  "args": ["build"],
  "cwd": "packages/foo",     // optional. relative paths resolve against the plan dir
  "timeoutMs": 60000,         // optional. default 30000
  "expectExitCode": 0          // optional. default 0
}
```

`cwd` always resolves against the directory containing the plan file when
relative. This makes plans portable. Use absolute paths for cross-repo work.

#### `tool`

Dispatch to a registered tool plugin under `<bankai>/src/tools/`. The tool
plugin owns all tactical knowledge for the binary it wraps.

```jsonc
{
  "kind": "tool",
  "id": "ask-kash",
  "tool": "kash",
  "config": { /* validated by the plugin's configSchema */ },
  "invocation": { /* validated by the plugin's invocationSchema */ },
  "cwd": ".",
  "timeoutMs": 90000
}
```

Registered tool plugins:

- **`kash`** — invokes the kash CLI. Plugin owns entrypoint discovery
  (Windows .cmd shim → node + dist/cli.js), bounded retries, and optional
  `kash refresh` between failed attempts.
  - `invocation`: `{ promptFile: string, outFile: string, subcommand?: string }`.
    Default subcommand is `prompt`. `promptFile` and `outFile` resolve
    against the plan dir when relative.
  - `config`: `{ binary?, baseArgs?, retries?, refreshOnRetry?, attemptTimeoutMs?, refreshTimeoutMs? }`.
    Production plans usually leave config empty and let discovery find kash
    on PATH. Tests inject `binary: process.execPath` plus a stand-in JS file.

### Assertion kinds (closed)

#### `step-output-contains`

```jsonc
{
  "kind": "step-output-contains",
  "id": "build-says-success",
  "stepId": "build",
  "stream": "stdout",     // or "stderr"
  "text": "Build succeeded"
}
```

#### `assert-text-contains`

Read a file from disk and assert its contents contain a substring. Use this
for artifacts your steps write (kash response files, generated reports). The
file path resolves against the plan dir when relative.

```jsonc
{
  "kind": "assert-text-contains",
  "id": "response-mentions-tool",
  "file": "out/response.txt",
  "text": "list_items"
}
```

### Environments (open)

`environment.kind` defaults to `noop`. Real environments (long-running dev
servers, hermetic sandboxes) are added by registering an EnvironmentPlugin
under `<bankai>/src/environments/`. For end-to-end tests against a running
dev server, the dev server is started by the `dev-loop` skill, not by the
test environment.

## Authoring a new plan

1. Pick a plan name. Kebab-case. The file goes at
   `<repo>/.bankai/plans/<name>.test.json`.
2. Copy the closest template from `plans/` next to this SKILL.md. Adapt
   the steps and assertions.
3. Run it. The envelope is the spec. If a field is wrong, fix the JSON, not
   the plan output.
4. If the plan needs a step kind or assertion kind that does not exist, add
   it to bankai under `src/steps/` or `src/assertions/`. Do NOT shoehorn
   logic into a `shell` step that another step kind should own.

### Quality bar

- **Self-contained.** A new agent must be able to run the plan with no
  conversation history. Embed every URL, every flight, every command.
- **Deterministic verification.** Pass criteria are checkable strings or
  values, not "looks right".
- **Bounded.** No step should be open-ended. Set `timeoutMs` on long steps.
- **Cleanup belongs to the env plugin.** If the plan leaves resources behind
  in `noop`, redesign as a real environment plugin instead of leaking from
  shell steps.

## Templates

Bundled inside this skill at `plans/`:

- [`plans/smoke-shell-only.test.json`](plans/smoke-shell-only.test.json) —
  trivial pass plan: one shell step, one stdout assertion. Use this to verify
  bankai itself is wired before authoring a real plan.
- [`plans/kash-prompt-and-assert.test.json`](plans/kash-prompt-and-assert.test.json) —
  kash invocation pattern. Reads a prompt file, writes the response, asserts
  on the response file. Most product test plans look like this.
- [`plans/multi-step-fail-fast.test.json`](plans/multi-step-fail-fast.test.json) —
  multi-step plan with a deliberate mid-pipeline failure to demonstrate
  envelope shape on partial runs.

## What this skill deliberately does NOT do

- Does not run unit tests.
- Does not start dev servers. Use the `dev-loop` skill for that.
- Does not modify code on a failing scenario. Stop and report.
- Does not invent step kinds or assertion kinds. Add them to bankai.
