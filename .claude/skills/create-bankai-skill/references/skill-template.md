# Skill template

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
4. Report `ok`, total elapsed time from top-level `durationMs`, failing step
   duration or `failure.reason`, and log path.

## Plans

- `plans\<plan-name>.json` - <what it does>
```
