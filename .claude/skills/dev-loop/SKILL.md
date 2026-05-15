---
name: dev-loop
description: |
  Manage long-running dev servers (and any persistent process) for any repo
  using the bankai orchestrator. A dev-loop plan is a self-contained,
  schema-validated JSON file under <repo>/.bankai/plans/<name>.dev-loop.json.
  It registers the started process under a stable handle name so the user
  can later 'bankai status' or 'bankai stop <name>' it from any shell. Use
  when the user says "/dev-loop start <name>", "start dev server <name>",
  "stop dev server <name>", or asks about the running dev environment.
metadata:
  userInvocable: true
---

# dev-loop

## Prime directive

`bankai run <plan.json>` starts a dev server. `bankai status` lists running
dev servers. `bankai stop <name>` stops one. There is no other orchestration
entry point.

A dev-loop plan is just a regular bankai plan whose first step is a `setup`
with `registerAs: "<handle-name>"` and whose final step is a `wait` for
readiness. The setup spawns the process detached, registers it in
`~/.bankai/state/registry.json`, and returns. The plan exits immediately
after `wait` succeeds; the process keeps running.

The user reclaims it later with `bankai stop <handle-name>` from any shell.

No PowerShell `Start-Process` wrappers. No ad-hoc port polling. No
hand-rolled PID files.

## When to run

- "/dev-loop start <name>" → resolve plan, run it.
- "start the dev server" / "spin up <name>" → resolve plan, run it.
- "is the dev server running?" → `bankai status [name]`.
- "stop the dev server" / "/dev-loop stop <name>" → `bankai stop <name>`.
- "what's broken with the dev server?" → `bankai status` then read the
  `logFile` reported in the entry, then read the JSONL run log of the
  original `bankai run`.

Do NOT run for short-lived commands (use the `test` skill or run the command
directly) or for unit tests.

## Execution

### Start

1. Resolve the plan file: `<repo>/.bankai/plans/<name>.dev-loop.json`.
2. Run: `bankai run .bankai\plans\<name>.dev-loop.json --pretty`.
3. Confirm with `bankai status --pretty` and report the registered handle.

### Status

```powershell
bankai status --pretty            # all entries
bankai status <name> --pretty     # one entry
```

The `alive` field is the truth. `alive: false` means the process died on
its own; the entry is stale and should be cleaned up with
`bankai doctor --prune`.

### Stop

```powershell
bankai stop <name> --pretty           # graceful, fingerprint-verified
bankai stop <name> --force --pretty   # skip fingerprint check
```

Use `--force` only when the fingerprint check fails (PID was reused by an
unrelated process). bankai will refuse to terminate a PID that does not
match the registered fingerprint without `--force`.

### Diagnose

If `bankai run` failed during setup or wait, the JSONL run log captures
every event (spawn, output lines, readiness probes, termination). Path is
printed in the `log:` line at the bottom of the `--pretty` output.

```powershell
Get-Content C:\Users\marcusm\repos\<repo>\.bankai\logs\run-<plan>-<ts>-<runId>.jsonl |
  ConvertFrom-Json |
  Where-Object { $_.event -like "step.wait.*" -or $_.event -like "step.setup.*" }
```

## Plan shape (canonical)

```jsonc
{
  "schemaVersion": "1",
  "name": "augloop-workflows",
  "description": "Optional human-readable summary",
  "steps": [
    {
      "kind": "setup",
      "id": "boot",
      "env": "managed-process",
      "registerAs": "augloop-workflows",
      "config": {
        "command": "node",
        "args": ["dist/server.js"],
        "cwd": ".",
        "logFile": ".bankai/logs/augloop-workflows.log",
        "env": { "NODE_ENV": "development" }
      },
      "setupTimeoutMs": 30000
    },
    {
      "kind": "wait",
      "id": "ready",
      "fromStepId": "boot",
      "for": [
        { "kind": "port", "id": "api", "host": "127.0.0.1", "port": 11040 }
      ],
      "timeoutMs": 60000,
      "pollIntervalMs": 250
    }
  ]
}
```

### Step kinds (only the ones dev-loop plans use)

#### `setup` (env: `managed-process`)

Spawns a process detached, captures stdout+stderr to `logFile`, returns a
`ProcessHandle` with `pid`, `command`, `args`, `cwd`, and `logFile`.

- Without `registerAs`: SCOPED. Bankai tears the process down at plan end.
  Use this for tests, NOT for dev-loop plans.
- With `registerAs: "<name>"`: PERSISTENT. The handle goes into
  `~/.bankai/state/registry.json`. The process outlives the plan. The user
  reclaims it with `bankai stop <name>`. If an entry already exists with
  `<name>` and the PID is alive and the fingerprint matches, the setup
  step refuses to start a duplicate.

`config` schema (`managed-process`):

```jsonc
{
  "command": "string",                 // required
  "args":    ["..."],                  // optional
  "cwd":     ".",                      // optional, relative to repoRoot
  "logFile": ".bankai/logs/x.log",     // required, dir is created if missing
  "env":     { "K": "V" },             // optional, merged onto process env
  "shell":   false                     // optional, default false
}
```

#### `wait`

Polls one or more readiness probes until all pass or `timeoutMs` elapses.
References the setup step via `fromStepId` (most common) or
`fromRegistry: "<name>"` (when waiting on a server registered earlier).

Probe kinds:

- `{ kind: "port", id, host, port }` — TCP connect succeeds.
- `{ kind: "log-line-matches", id, pattern }` — regex match anywhere in
  the new portion of `logFile` since setup.

#### `stop`

Rare in dev-loop plans (use `bankai stop <name>` from the shell). Useful
inside a "shutdown" plan.

```jsonc
{
  "kind": "stop",
  "id": "kill",
  "registry": "augloop-workflows",
  "force": false
}
```

## Authoring a new dev-loop plan

1. Pick a handle name. Kebab-case, repo-unique. The file goes at
   `<repo>/.bankai/plans/<name>.dev-loop.json`.
2. Copy the closest template from `plans/`. Replace
   `REPLACE-ME-handle-name`, the command, the args, and the readiness
   probes.
3. Validate it: `bankai doctor --plan .bankai\plans\<name>.dev-loop.json`.
4. Run it: `bankai run .bankai\plans\<name>.dev-loop.json --pretty`.
5. Verify: `bankai status --pretty` shows the entry with `alive: true`.
6. Tear down to confirm the lifecycle: `bankai stop <name> --pretty`.

### Quality bar

- **Stable handle name.** Pick one and stick with it across the plan,
  status output, and stop commands.
- **logFile is a real path under `.bankai/logs/`.** No relative paths into
  the repo source tree. The dir must be writable.
- **Wait actually verifies readiness.** A port probe AND a log-line probe
  is fine. A wait with no probes is invalid.
- **Bounded waits.** Set `timeoutMs` on every wait step. `pollIntervalMs`
  defaults to 250.
- **No teardown step in a dev-loop plan.** The point of `registerAs` is
  that the process outlives the plan.

## Templates

Bundled inside this skill at `plans/`:

- [`plans/node-server.dev-loop.json`](plans/node-server.dev-loop.json) —
  generic node server gated on a TCP port. Replace command, args, port,
  handle name.
- [`plans/log-line-server.dev-loop.json`](plans/log-line-server.dev-loop.json) —
  server gated on a log line (for example "READY"). Replace command, args,
  pattern, handle name.

## What this skill deliberately does NOT do

- Does not run unit tests or short-lived commands. Use the `test` skill or
  run the command directly.
- Does not modify the dev server's source code on a failing setup. Stop and
  report. Inspect the JSONL log and the dev server `logFile` first.
- Does not invent env plugins or readiness probe kinds. Add them to bankai
  under `src/environments/` or `src/readiness/`.
- Does not poll the dev server forever. Every wait has `timeoutMs`.
