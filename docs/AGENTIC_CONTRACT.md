# Bankai Agentic Contract

Bankai is an agentic-first orchestration engine. Agents should treat the CLI as
the product API and plans as the portable workflow description.

## Source of truth

- `src/cli.ts` defines the command surface.
- `src/plan/schema.ts` defines valid plan JSON.
- `src/plan/envelope.ts` defines the run/status/logs/stop envelope shape.
- `bankai schema plan` and `bankai schema bindings` expose machine-readable
  schema references for agent-generated plans and bindings.

## Output contract

Commands that produce operational output write one JSON envelope to stdout.
Human-readable progress should not be required for agent control flow.

```json
{
  "ok": true,
  "command": "run",
  "startedAt": "2026-01-01T00:00:00.000Z",
  "finishedAt": "2026-01-01T00:00:01.000Z",
  "durationMs": 1000,
  "runId": "abc12345",
  "logFile": "C:\\Users\\alice\\.bankai\\logs\\run-plan-abc12345.jsonl",
  "steps": [],
  "registry": []
}
```

Failures stay structured:

```json
{
  "ok": false,
  "command": "run",
  "failure": {
    "stage": "step",
    "reason": "attached-process plan reported failure before readiness"
  },
  "steps": []
}
```

## Command model

```text
bankai run <plan>
bankai status [name]
bankai logs [name]
bankai stop <name>
bankai doctor [--plan <path>] [--prune]
bankai update
bankai schema plan|bindings
```

`--json` is accepted for compatibility, but JSON is the default output format.

## Dev-loop lifecycle

For attached dev loops, `bankai run <plan>` is the startup proof. It blocks
until the process reports readiness, fails, or times out. On success, the
envelope includes a `registry` entry with:

- `name`
- `pid`
- `alive`
- `status.phase`
- `status.currentStepId`
- `status.ready`
- `status.done`
- `steps`
- `logs`

Agents should not call `bankai status` immediately after a successful
`bankai run` just to prove startup. Use the `registry` entry returned by `run`.

Use `bankai status [name]` later to inspect current state. Status is concise by
design and should not include detailed log text.

Use `bankai logs [name]` when detailed run or terminal output is needed.

Use `bankai stop <name>` to stop a registered handle. Attached-process plans use
the Ctrl+C control path, verify tracked processes exit, and only clean exact
tracked descendants when needed.

## Plan generation rules

- Generate schema-valid plans.
- Use bindings for machine-local paths instead of hardcoding user directories.
- Put readiness and failure detection in the plan, not in agent-side polling.
- Use explicit timeouts for long-running steps.
- Prefer generic steps and assertions over product-specific plugins.
- Keep secrets out of plans, registry entries, logs, and assertions.

## Agent prompts Bankai should handle

- *"Start this repo's dev loop and return only after the server is ready"*
- *"Stop the dev loop and verify the tracked process tree is gone"*
- *"Show concise status for all running Bankai handles"*
- *"Show the detailed logs for the `local-api` handle"*
- *"Validate this generated plan before running it"*
- *"Run this smoke test plan and report the failing step id and reason"*
- *"Generate bindings JSON for the workspace path and run the plan with it"*
- *"Update this Bankai checkout and rebuild only if new changes arrived"*
