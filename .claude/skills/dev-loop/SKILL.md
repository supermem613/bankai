---
name: dev-loop
description: |
  Manage long-running dev servers with Bankai. Use when the user says
  "/dev-loop start <name>", "start dev server <name>", "stop dev server
  <name>", or asks about the running dev environment.
metadata:
  userInvocable: true
---

# dev-loop

## Prime directive

`bankai run <plan.json>` starts a dev loop and returns the start proof. For
attached dev loops, the run command blocks until readiness is observed or
failure is reported. The run response includes the registered handle summary:
name, PID, alive, phase, ready/done booleans, step summary, and log path.

Do not run `bankai status` immediately after a successful `bankai run` just to
prove startup. Use the `registry` entry returned by `run`.

Use later:

```powershell
bankai status <name>
bankai logs <name>
bankai stop <name>
```

There is no other orchestration entry point. No PowerShell `Start-Process`
wrappers. No hand-rolled PID files. No ad-hoc readiness polling outside the
Bankai plan.

## When to run

- "/dev-loop start <name>" -> resolve plan, run it.
- "start the dev server" / "spin up <name>" -> resolve plan, run it.
- "is the dev server running?" -> `bankai status [name]`.
- "show dev server logs" / "what happened?" -> `bankai logs [name]`.
- "stop the dev server" / "/dev-loop stop <name>" -> `bankai stop <name>`.

Do not use this skill for short-lived commands or unit tests.

## Execution

### Start

1. Resolve the plan file from this skill's `plans\` directory or from the
   loaded skill context.
2. Validate it with `bankai doctor --plan <plan>`.
3. Run it with `bankai run <plan>`.
4. Report the `registry` entry from the run envelope. It is the start proof.

Expected successful attached-process state:

```json
{
  "registry": [
    {
      "name": "handle-name",
      "pid": 12345,
      "alive": true,
      "status": {
        "phase": "ready",
        "ready": true,
        "done": false
      },
      "logs": {
        "run": { "path": "...", "exists": true }
      }
    }
  ]
}
```

For dev servers, `ready: true` and `done: false` is correct. The server is
usable and still running.

### Status

Use status only for later inspection or when the user asks what is currently
running:

```powershell
bankai status
bankai status <name>
```

Status must stay concise. It reports phase/current step/ready-vs-done and log
paths. It does not dump detailed log text.

### Logs

Use logs when detail is needed:

```powershell
bankai logs <name>
```

### Stop

```powershell
bankai stop <name>
```

For attached-process plans, Bankai requests Ctrl+C through the attached-process
controller, verifies tracked processes exit, and only escalates exact lingering
tracked descendants when needed.

## Attached-process plan shape

Use `attached-process` for dev servers that need visible terminal ownership or
native Ctrl+C lifecycle:

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
        { "id": "compile-failed", "stream": "any", "contains": "Compilation failed" },
        { "id": "port-in-use", "stream": "any", "contains": "port is already in use" }
      ],
      "verifyReady": [
        { "kind": "port", "id": "app", "host": "127.0.0.1", "port": 3000 }
      ]
    }
  ]
}
```

## Persistent setup plan shape

Use `setup` plus `wait` only for detached dev loops where Ctrl+C terminal
ownership is not part of the contract:

```jsonc
{
  "schemaVersion": "1",
  "name": "local-api",
  "steps": [
    {
      "kind": "setup",
      "id": "boot",
      "env": "managed-process",
      "registerAs": "local-api",
      "config": {
        "command": "node",
        "args": ["dist/server.js"],
        "logFile": ".bankai/logs/local-api.log"
      }
    },
    {
      "kind": "wait",
      "id": "ready",
      "fromStepId": "boot",
      "for": [
        { "kind": "port", "id": "api", "host": "127.0.0.1", "port": 11040 }
      ],
      "timeoutMs": 60000
    }
  ]
}
```

## Quality bar

- Stable handle name across run/status/logs/stop.
- `bankai run` must return the handle summary. Do not add a follow-up status
  call unless inspecting later state.
- Readiness must be declared in the plan with output and/or probe checks.
- Every readiness path is bounded by `timeoutMs`.
- Detailed log text belongs in `bankai logs`, not `bankai status`.
- No teardown step in a dev-loop plan unless the plan is explicitly a shutdown
  plan.
