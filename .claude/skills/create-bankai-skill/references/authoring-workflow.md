# Authoring workflow

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

## Validation gates

- The plan is schema-valid.
- Machine-local paths are bindings, not literals.
- Readiness and failure patterns live in the plan.
- Every long-running step has a timeout.
- The skill reports total elapsed time from top-level `durationMs`.
- Failure reports include the failed step id, failed step `durationMs`, `failure.reason`, and log path when present.
