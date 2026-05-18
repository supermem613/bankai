---
name: test
description: |
  Run end-to-end test plans against any repo using the bankai orchestrator.
  Each plan is a self-contained, schema-validated JSON file in this skill's
  plans directory. Bankai validates the plan, runs every
  step (including assert steps), and returns a single JSON envelope. Use when
  the user says "/test <name>", "test <name>", "run the <name> test plan", or
  "verify <name> end-to-end". Repo-agnostic.
metadata:
  userInvocable: true
---

# test

## Prime directive

`bankai run <plan.json>` is the only orchestration entry point. A plan is a
self-contained, schema-validated JSON file. Your job is to pick the right
plan, run bankai, parse the envelope, and report the result.

No PowerShell wrapper loops. No improvised `Get-Process` health checks. No
assert-via-grep glue. If a plan needs a step kind that bankai does not have,
add it to bankai under `src/steps/`. Do NOT smuggle orchestration logic into
the plan itself or into this skill text.

## When to run

- `/test <name>` or `test <name>`
- "run the <name> test plan", "verify <name> end-to-end"
- Validation after a code change in a known-tested area, when the user names
  a plan or a clear plan name can be inferred

Do NOT run for unit tests (`yarn test`, `npm test`) or pure design questions.

## Execution

### 1. Resolve the plan file

Plans live in this skill's `plans\` directory. Resolve that directory from the
loaded skill context, not from the target repo.

```powershell
$plansDir = Join-Path $skillBase 'plans'
$planPath = Get-ChildItem -Path $plansDir -Filter *.test.json -Recurse |
  Where-Object { $_.BaseName -like "*<name>*" } |
  Select-Object -First 1 -ExpandProperty FullName
Write-Output $planPath
```

If the user-supplied name does not exactly match a file, prefer the closest
suffix match. Ask if more than one matches.

### 2. Run the plan

```powershell
bankai run $planPath
```

Stdout is the envelope JSON. The exit code is the truth: `0` on pass, `1`
on any failure (validation, setup, step, assert, teardown).

If `bankai` is not on PATH, stop and report that Bankai must be built and
linked before this skill can run. Do not guess machine-local repository paths.

### 3. Read the envelope

The envelope contract is defined in `<bankai>/src/plan/envelope.ts`. Fields
that drive the next step:

- `ok` — boolean. AND of every step result.
- `failure.stage` — `load-plan | preflight | setup | step | wait | stop | teardown | internal`.
  Tells you which phase aborted.
- `failure.reason` — human-readable cause.
- `steps[]` — each has `id`, `kind`, `ok`, `durationMs`, plus a kind-specific
  block (`shell`, `tool`, `assert`, `setup`, `wait`, `stop`, `runPlan`).
- `steps[].shell.stdoutTail` and `stderrTail` are 4 KB tails. The full
  output lives in the JSONL log file at `envelope.logFile`.
- The first step with `ok: false` stops the run unless that step had
  `continueOnFail: true`. Later steps are reported as skipped.

### 4. Report the result

Always end with a one-line headline plus, on failure, the failing step id
and reason verbatim from `failure.reason`. On pass, the headline is enough.

```text
PASS  plan "skills-smoke" (4 steps, 2.4s)
FAIL  plan "skills-smoke" — step "site-tools-bound" — file ".bankai/out/tools.txt" does NOT contain "list_items"
```

## Plan shape (canonical)

Every plan is a JSON file matching this shape. The full schema lives in
`<bankai>/src/plan/schema.ts`. Source of truth is the schema; this section
is a quick reference.

```jsonc
{
  "schemaVersion": "1",
  "name": "skills-smoke",
  "description": "Optional human-readable summary",
  "requires": {
    "bindings": {
      "workspace": { "type": "path", "required": false }
    }
  },
  "steps": [
    /* StepRefs, executed in order, stop on first failure unless continueOnFail */
  ]
}
```

There is one plan shape and one step list. Assertions are a step kind
(`assert`), not a separate phase. To see step-by-step pass/fail without
short-circuiting, set `continueOnFail: true` on each `assert` step.

### Step kinds (closed)

#### `shell`

Run a short-lived command, capture stdout, stderr, and exit code.

```jsonc
{
  "kind": "shell",
  "id": "build",
  "command": "yarn",
  "args": ["build"],
  "cwd": { "binding": "workspace" }, // optional. from required bindings
  "timeoutMs": 60000,         // optional. default 30000
  "expectExitCode": 0          // optional. default 0
}
```

`cwd` can reference a required binding when a plan needs machine-local paths.
Pass values with `--bindings-file` or `--bindings-json`.

#### `tool`

Dispatch to a registered tool plugin under `<bankai>/src/tools/`. Bankai ships
no product-specific tool plugins. Prefer `shell` for project-specific CLIs.

```jsonc
{
  "kind": "tool",
  "id": "ask-tool",
  "tool": "example-tool",
  "config":     { /* validated by the plugin's configSchema */ },
  "invocation": { /* validated by the plugin's invocationSchema */ },
  "cwd": ".",
  "timeoutMs": 90000
}
```

Product-specific CLIs should usually be modeled with `shell`:

```jsonc
{
  "kind": "shell",
  "id": "ask-cli",
  "command": "agent-cli",
  "args": ["prompt", "--prompt-file", "prompt.txt", "--out", "response.txt"],
  "resolveCommand": true,
  "retries": 1,
  "timeoutMs": 180000
}
```

`resolveCommand: true` preserves Windows `.cmd` shims without hardcoding a
tool's internal JavaScript entrypoint.

#### `assert`

Dispatch to a registered assertion plugin under `<bankai>/src/assertions/`.
Use `continueOnFail: true` if you want every assertion to report.

```jsonc
{
  "kind": "assert",
  "id": "build-says-success",
  "assertion": "step-output-contains",
  "config": {
    "stepId": "build",
    "stream": "stdout",     // or "stderr"
    "text": "Build succeeded"
  },
  "continueOnFail": true
}
```

Registered assertion plugins:

- **`step-output-contains`** — substring match on a prior shell or tool
  step's stdout or stderr. Config: `{ stepId, stream, text }`.
- **`assert-text-contains`** — substring match on a file under repo root.
  Config: `{ file, text }`. Use this for artifacts steps write to disk.

#### `setup`, `wait`, `stop`, `run-plan`

Used by long-running workflows. See the `dev-loop` skill for full coverage.
Test plans rarely use these directly; instead they reference a dev server
the user already started with `dev-loop`.

## Authoring a new plan

1. Pick a plan name. Kebab-case. The file goes at
   `plans\<name>.test.json` next to this SKILL.md.
2. Copy the closest template from `plans/` next to this SKILL.md. Adapt
   the steps.
3. Validate it: `bankai doctor --plan $planPath`.
4. Run it: `bankai run $planPath`. The
   envelope is the spec. If a field is wrong, fix the JSON, not the output.
5. If a needed step kind or assertion kind is missing, add it to bankai under
   `src/steps/` or `src/assertions/`. Keep project-specific CLIs in plans unless
   the behavior is generic enough to publish.

### Quality bar

- **Self-contained.** A new agent must be able to run the plan with no
  conversation history. Embed every URL, every flight, every command.
- **Deterministic verification.** Pass criteria are checkable strings or
  values, not "looks right".
- **Bounded.** Set `timeoutMs` on every long step.
- **Cleanup belongs to setup.** If a plan starts a process, use a `setup`
  step (scoped, no `registerAs`) so bankai tears it down on plan end.

## Templates

Bundled inside this skill at `plans/`:

- [`plans/smoke-shell-only.test.json`](plans/smoke-shell-only.test.json) —
  trivial pass plan: one shell step, one step-output assertion. Use this to
  verify bankai itself is wired before authoring a real plan.
- [`plans/external-cli-prompt-and-assert.test.json`](plans/external-cli-prompt-and-assert.test.json) —
  external CLI invocation pattern. Reads a prompt file, writes the response,
  asserts on the response file. Most product test plans look like this.
- [`plans/multi-step-fail-fast.test.json`](plans/multi-step-fail-fast.test.json) —
  multi-step plan with a deliberate mid-pipeline failure to demonstrate
  envelope shape on partial runs.

## What this skill deliberately does NOT do

- Does not run unit tests.
- Does not start dev servers. Use the `dev-loop` skill for that.
- Does not modify code on a failing plan. Stop and report.
- Does not invent step kinds or assertion kinds. Add them to bankai.
