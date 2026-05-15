# Agentic defaults checklist

Apply this checklist before and after scaffolding. If a CLI intentionally
violates an item, document why in the README and tests.

## Command surface

- Bare command prints version and help for humans.
- `--help` and `--version` use the CLI framework defaults.
- Every command has a one-line description and concrete examples.
- One file per command. Shared logic lives outside command entry files.
- Commands route from explicit inputs: URLs, paths, profile names, IDs, or flags.

## Machine-readable contract

- Agent-facing non-interactive commands emit JSON by default.
- Human rendering is opt-in through `--human` or an interactive command.
- JSON stdout contains JSON only.
- Progress, warnings, debug, and remediation text go to stderr.
- JSON envelopes keep stable top-level fields. Add optional fields, do not
  rename or remove existing ones.
- Error exits include a clear remediation hint when the user can fix the issue.

Recommended JSON envelope for agent-facing commands:

```json
{
  "ok": true,
  "command": "<verb>",
  "data": {},
  "warnings": [],
  "timingMs": 0
}
```

Recommended health-check shape:

```json
{
  "ok": true,
  "checks": [
    {
      "name": "node",
      "ok": true,
      "detail": "Node 24.0.0",
      "hint": "Install Node 24 or later"
    }
  ]
}
```

## Doctor command

- Ship `doctor` in the first version.
- `doctor` emits the health-check shape above by default for agent-facing CLIs.
- If human output is useful, provide `doctor --human` or an interactive health
  view without changing the default stdout contract.
- Failed checks include copy-paste remediation hints.
- Auth, config, daemon, browser-profile, and dependency checks belong here, not
  as scattered startup failures.

## Mutations and safety

- Mutating commands compute a complete plan before writing.
- Preview includes files, remote resources, state files, and follow-on actions.
- Apply requires confirmation or an explicit `--yes`.
- Unresolved conflicts block apply.
- Commit, push, publish, force-push, reset, revert, and tag operations require
  separate explicit confirmation.
- Empty-state and first-run paths get tests.

## Daemon and live surfaces

- Use a daemon when work needs a browser, authenticated session, long-lived
  process, or serialized access to product state.
- Commands are short-lived. Daemon owns browser/session state.
- Use line-delimited JSON for local transports unless the repo already has a
  better explicit protocol.
- Completion waits for product-visible completion signals and UI idle signals.
  Do not rely on blind waits.

## Testing

- Use the `create-repo` HOME-sandboxed runner for TypeScript CLI repos.
- Tests must not read the developer's real home directory or local config by
  default.
- Prefer pure unit tests for parsers, state machines, routing, and protocol
  envelopes.
- Add integration tests for command lifecycle and failure recovery.
- Live e2e tests are opt-in and require a documented real target.

## Dependencies and portability

- Keep runtime dependencies lean. The `create-repo` baseline starts with
  `chalk`, `commander`, and `zod`.
- Prefer Node.js built-ins in generated scripts.
- Avoid shell-specific commands in generated scripts.
- When spawning `.cmd` targets on Windows from Node.js, pass `shell: true`.
- Accept real-world identifiers. Do not overconstrain GitHub users, orgs,
  profile names, or account labels to kebab-case.

## Skill-backed CLI rules

- `SKILL.md` dispatches. Scripts execute.
- Every reusable script supports `--help`.
- Every structural schema needed by a fresh agent is embedded or referenced.
- Run `lint-skill` after creating or modifying the skill.
