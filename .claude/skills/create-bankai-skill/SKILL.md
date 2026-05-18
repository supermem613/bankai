---
name: create-bankai-skill
description: |
  Create agent skills that use Bankai plans for execution. Use when the user
  wants to build a new dev-loop, test, validation, or workflow skill backed by
  bankai run/status/logs/stop instead of ad-hoc shell orchestration.
metadata:
  userInvocable: true
---

# create-bankai-skill

## Prime directive

Create thin skills. Bankai owns execution. The skill owns routing, plan
selection, and result interpretation.

Do not embed process management, readiness polling, retry loops, PID files, or
assert-via-grep logic in skill prose. Put executable behavior in a
schema-validated Bankai plan and call:

```powershell
bankai doctor --plan <plan>
bankai run <plan>
bankai status <name>
bankai logs <name>
bankai stop <name>
bankai schema plan
```

## When to run

- "create a Bankai-backed skill"
- "make a skill for this dev server"
- "make a skill that runs this validation workflow"
- "turn this command sequence into an agent skill"
- "create a dev-loop/test skill using Bankai"

Do not use this skill for a one-off command. Use it when the workflow should be
reused by agents.

## Output shape

Create a directory:

```text
.claude/skills/<skill-name>/
  SKILL.md
  plans/
    <workflow-name>.json
```

Use `.dev-loop.json` for persistent dev servers and `.test.json` for bounded
test or validation workflows.

## Authoring workflow

1. Identify the user-facing trigger phrases.
2. Pick the Bankai plan type:
   - `attached-process` for visible-terminal dev servers that need native Ctrl+C.
   - `setup` plus `wait` for detached persistent processes.
   - `shell` plus `assert` for bounded validation workflows.
3. Move every executable detail into `plans\`.
4. Keep `SKILL.md` as a thin router:
   - when to run
   - which plan to select
   - which Bankai command to call
   - how to interpret the envelope
   - what not to do
5. Use `bankai schema plan` if the plan shape is uncertain.
6. Validate with `bankai doctor --plan <plan>`.
7. Run with `bankai run <plan>`.
8. For dev-loop plans, verify stop with `bankai stop <name>`.

## Skill template

```markdown
---
name: <skill-name>
description: |
  Use when <user intent>. Runs Bankai plan files instead of ad-hoc shell
  orchestration.
metadata:
  userInvocable: true
---

# <skill-name>

## Prime directive

`bankai run <plan>` is the only execution entry point. The skill resolves the
plan, runs Bankai, reads the JSON envelope, and reports the result.

No hand-written process management. No custom polling. No PID files. No
machine-local paths in the skill text.

## When to run

- "<trigger phrase>"

## Execution

1. Resolve the plan under this skill's `plans\` directory.
2. Run `bankai doctor --plan <plan>`.
3. Run `bankai run <plan>`.
4. Report `ok`, failing step or `failure.reason`, and log path.

## Plans

- `plans\<plan-name>.json` - <what it does>
```

## Dev-loop plan template

```jsonc
{
  "schemaVersion": "1",
  "name": "local-dev-loop",
  "requires": {
    "bindings": {
      "workspace": { "type": "path", "required": true }
    }
  },
  "steps": [
    {
      "kind": "attached-process",
      "id": "dev",
      "registerAs": "local-dev-loop",
      "command": "npm",
      "args": ["run", "dev"],
      "cwd": { "binding": "workspace" },
      "timeoutMs": 600000,
      "readyWhen": [
        { "id": "ready-line", "stream": "stdout", "contains": "ready" }
      ],
      "failWhen": [
        { "id": "compile-failed", "stream": "any", "contains": "Compilation failed" }
      ],
      "verifyReady": [
        { "kind": "port", "id": "app", "host": "127.0.0.1", "port": 3000 }
      ]
    }
  ]
}
```

## Test plan template

```jsonc
{
  "schemaVersion": "1",
  "name": "workflow-smoke",
  "requires": {
    "bindings": {
      "workspace": { "type": "path", "required": true }
    }
  },
  "steps": [
    {
      "kind": "shell",
      "id": "run-workflow",
      "command": "npm",
      "args": ["test"],
      "cwd": { "binding": "workspace" },
      "timeoutMs": 120000
    },
    {
      "kind": "assert",
      "id": "test-output",
      "assertion": "step-output-contains",
      "config": {
        "stepId": "run-workflow",
        "stream": "stdout",
        "text": "pass"
      }
    }
  ]
}
```

## Quality bar

- The plan is schema-valid.
- Machine-local paths are bindings, not literals.
- Readiness and failure patterns live in the plan.
- Every long-running step has a timeout.
- The skill does not parse human terminal prose when the Bankai envelope already
  has structured fields.
- Dev-loop skills explain that `bankai run` returns the startup proof and
  `bankai status` is for later inspection.
