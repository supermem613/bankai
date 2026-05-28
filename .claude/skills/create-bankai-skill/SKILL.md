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
bankai schema bindings
```

→ See [authoring workflow](references/authoring-workflow.md) for the full sequence.
→ See [skill template](references/skill-template.md) for the SKILL.md shape.
→ See [plan templates](references/plan-templates.md) for dev-loop and test plan examples.

## When to run

- "create a Bankai-backed skill"
- "make a skill for this dev server"
- "make a skill that runs this validation workflow"
- "turn this command sequence into an agent skill"
- "create a dev-loop/test skill using Bankai"

Do not use this skill for a one-off command. Use it when the workflow should be
reused by agents.

## Output shape

Create a directory with a `SKILL.md` router and plan files:

```text
.claude/skills/<skill-name>/
  SKILL.md
  plans/
    <workflow-name>.json
```

Use `.dev-loop.json` for persistent dev servers and `.test.json` for bounded
test or validation workflows.

## Quality bar

- The plan is schema-valid.
- Machine-local paths are bindings, not literals.
- Runtime bindings use either a bindings file, the original `{key,value}` array
  shape, or object shorthand such as `{"workspace":"C:\\repo"}`.
- Readiness and failure patterns live in the plan.
- Every long-running step has a timeout.
- The skill does not parse human terminal prose when the Bankai envelope already
  has structured fields.
- Dev-loop skills explain that `bankai run` returns the startup proof and
  `bankai status` is for later inspection. Status may include the latest
  fatal/progress detail, but detailed log text stays in `bankai logs`.

→ See [authoring workflow](references/authoring-workflow.md) for validation gates.
