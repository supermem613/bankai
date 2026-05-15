# Handoff to create-repo

`create-cli` does not own the standard TypeScript CLI scaffold. Use the existing
`create-repo` skill and script for standard CLIs, then patch for the selected
archetype.

## Standard CLI or CLI-backed skill

Use `create-repo` for the baseline:

```text
node <create-repo skill>\scripts\create-repo.js <name> --description "<one-line description>" [--bin <name>] [--windows-only]
```

The generated baseline includes:

- ESM TypeScript on Node 24+
- Commander CLI entry
- `doctor` command. Patch it so agent-facing output is JSON by default.
- ESLint and TypeScript strictness
- HOME-sandboxed `node:test` runner
- Ubuntu and Windows CI, or Windows-only when requested
- README, LICENSE, `.gitignore`, and standard scripts

After scaffold, patch only what the archetype requires.

## Deterministic artifact patch

Add:

- `src/core/` for parser, validator, and planner.
- A command that defaults to dry-run or read-only mode.
- Fixture-based integration tests.
- README section documenting artifact schemas and output shape.

Preserve:

- No provider calls in generated runtime scripts.
- Explicit input paths and output paths.
- Atomic writes where practical.

## State-mutating sync patch

Add:

- `src/core/state.ts` for persisted state shape.
- `src/core/plan.ts` for change classification.
- `src/commands/plan.ts` and `src/commands/apply.ts`, or a single command with
  explicit `--apply`.
- Tests for fresh state, no-op state, conflict state, and resolved apply.

Preserve:

- Plan -> preview -> confirm -> apply.
- Unresolved conflicts block apply.
- Machine-local state stays out of the repo unless the user explicitly designs
  shared config.

## Live authenticated daemon patch

Add:

- `src/daemon/` for daemon host and lifecycle.
- `src/transport/` for line-delimited JSON protocol.
- `src/bridge/` for product-specific browser or app bridge.
- Commands such as `start`, `stop`, `status`, and the primary operation.
- `doctor` checks for daemon status, auth profile, and required local tools.

Preserve:

- CLI processes stay short-lived.
- Daemon owns browser/session state.
- stdout stays parseable for non-interactive commands.

## Git/auth helper patch

Add:

- Protocol parser tests with exact stdin/stdout fixtures.
- Stubbed external command tests.
- Recovery flows that keep stdout clean and put remediation on stderr.

Preserve:

- Hot path budget.
- Routing by explicit protocol input.
- Ecosystem auth drivers before custom OAuth.

## CLI-backed skill patch

Create a user skill beside the repo or in the requested skill directory:

```text
<skill-name>\
  SKILL.md
  references\
  scripts\
```

The skill should:

- Describe when to use the CLI.
- Give exact commands to run.
- Define output parsing expectations.
- Load large references on demand.
- Run repo validation and `lint-skill` before delivery.

## Copilot CLI extension repo

Do not run the standard `create-repo` scaffolder for extension repos. Use this
shape instead:

```text
<repo>\
  .github\
    extensions\<name>\extension.mjs
    workflows\ci.yml
  scripts\install-extension-shim.mjs
  skills\<name>-install\SKILL.md
  plugin.json
  package.json
  README.md
  LICENSE
  .gitignore
```

Minimum `plugin.json`:

```json
{
  "name": "<name>",
  "version": "0.1.0",
  "author": "Marcus Markiewicz",
  "license": "MIT",
  "skills": "skills/"
}
```

Extension package rules:

- `"type": "module"`
- Node 22+ for local compatibility with the Copilot CLI host
- No runtime dependencies by default
- CI checks Ubuntu, Windows, and macOS on Node 22 and 24

Install skill responsibilities:

- Locate the installed plugin under the Copilot CLI plugin directory.
- Write a real user extension directory.
- Create `extension.mjs` as a one-line dynamic import shim.
- Refuse to overwrite a symlink or junction.

## Validation commands

For standard CLI repos:

```text
npm install
npm run build
npm run lint
npm test
```

For CLI-backed skills:

```text
node <lint-skill skill>\scripts\lint-skill.mjs <skill path>
```

For Copilot CLI extension repos:

```text
npm run check
npm test
```

Do not publish, push, or install globally unless the user explicitly confirms
that separate step.
