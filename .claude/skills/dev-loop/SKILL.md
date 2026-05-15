---
name: dev-loop
description: |
  Trial replacement for ~/.copilot/skills/dev-loop/. Will drive
  bankai dev-loop start against a plan file under .bankai/plans/ once the
  bankai dev-loop CLI ships. Until then, fall back to the legacy
  ~/.copilot/skills/dev-loop/scripts/dev-loop-cli.mjs. Iterate the skill
  text inside this repo.
metadata:
  userInvocable: true
  trial: true
---

# dev-loop (bankai trial)

## Status

The bankai dev-loop CLI is in development. Until it ships:

- Use `~/.copilot/skills/dev-loop/scripts/dev-loop-cli.mjs` as today.
- Use this file as the forward-looking reference for what bankai will do.

The bankai test runner is already live and replaces the legacy test-cli.mjs;
see `.claude/skills/test/SKILL.md`.

## What it will do

`bankai dev-loop start --plan <plan.json>` will own the long-running side of
iterative work: starting a dev server through an EnvironmentPlugin, watching
its logs, and surfacing a typed status envelope.

The plan file will be a sibling of the test scenario file under
`.bankai/plans/`. Iteration state will be written to `.bankai/state/` so a
plan can resume after a crash, and per-run artifacts will land in the
session folder under HOME.

## Forward-compatible plan shape (draft)

```jsonc
{
  "schemaVersion": "1",
  "name": "augloop-workflows-dev-loop",
  "environment": {
    "kind": "augloop",
    "config": {
      "repoRoot": "C:/augloop-workflows",
      "ports": { "api": 11040, "health": 8989, "management": 8888 }
    },
    "setupTimeoutMs": 120000
  },
  "stages": [
    { "kind": "build",  "id": "augloop-build",  "package": "<scope>" },
    { "kind": "watch",  "id": "augloop-watch",  "logFile": "logs/dev-server.log" },
    { "kind": "verify", "id": "ports-bound",    "ports": [11040] }
  ]
}
```

The exact stage kinds will be defined and tested before the CLI ships.

## Environment plugin layer

The plugin contract lives at `src/environments/_interface.ts`. Today only
`noop` is registered. The augloop plugin will:

- Doctor: structural check that the augloop CLI is on PATH and the repo root
  exists.
- DoctorLive: probe ports 11040, 8989, and 8888 for any prior-run leftovers
  and warn on conflict.
- Setup: spawn the dev server through `spawnHeadless` (no Start-Process,
  windowsHide enabled), defer kill on `ctx.scope`, return capabilities with
  `ports` and `endpoints`.
- Teardown: kill the process and unwind the scope.

## What this trial will replace

- `~/.copilot/skills/dev-loop/scripts/dev-loop-cli.mjs` (275 lines of
  PowerShell-spawning Start-Process logic and ad-hoc port polling).
- The legacy `Start-Process powershell.exe -NoExit` pattern that is not
  headless-safe and silently leaks processes.
