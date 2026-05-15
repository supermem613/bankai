---
name: create-repo
description: |
  Scaffold a new TypeScript Node CLI repo under ~/repos/<name>/ following the
  conventions used by rotunda, kash, and reflux (ESM, Node 24+, commander,
  cross-platform tests with HOME-sandboxed runner, GH Actions CI).
  Use when the user asks to "create a new repo", "bootstrap a repo",
  "scaffold a CLI", "make a new project like rotunda/kash/reflux", "build a
  Copilot CLI extension", or wants to publish a scaffolded repo to GitHub.
metadata:
  userInvocable: true
---

# create-repo

## Core Principles

1. **One scaffolder, one shot.** Run `scripts/create-repo.js` with a name and
   description. Do not hand-write package.json/tsconfig.json — the conventions
   below are encoded in templates and stay consistent across repos.
2. **Match the existing trio (rotunda, kash, reflux).** Same TS settings, same
   test runner, same CI shape, same `doctor` command shape. Diverge only with
   a documented reason.
3. **Lean deps are a feature.** Runtime deps default to 3 (chalk, commander,
   zod). Adding a fourth requires justification — every runtime dep is
   supply-chain risk and slows install.
4. **Verify on the spot.** The scaffolder runs `npm install`, `npm run build`,
   and `npm test` so a green smoke test proves the tree is internally
   consistent before the user touches it.

## Input Handling

Required from the user:

- **name** (kebab-case): becomes the directory and the npm package name.
- **one-line description**: goes into `package.json.description` and the README.

Optional:

- **bin name** (defaults to the repo name)
- **windows-only** (CI Windows-only, `os: ["win32"]` in package.json) — set this
  for repos that interact with Windows-only APIs (like reflux).
- **repos-dir** (defaults to `~/repos`)

If the user gives only a vague request, ask one question at a time via
`ask_user` (name first, then description, then windows-only if unclear).

## Invocation

```bash
node ~/.copilot/skills/create-repo/scripts/create-repo.js <name> \
  --description "<one-liner>" \
  [--bin <name>] [--windows-only] [--repos-dir <path>] \
  [--no-install] [--no-git]
```

The script:
1. Validates `<name>` is kebab-case.
2. Refuses to overwrite an existing directory.
3. Writes the file tree below from embedded templates.
4. Runs `git init -b main`, `npm install`, `npm run build`, `npm test`.
5. Prints the `gh repo create` command for the user to publish when ready.

## Repo Format Reference

Every scaffolded repo has this exact shape:

```
~/repos/<name>/
├── .github/workflows/ci.yml       # Ubuntu+Windows matrix (or Windows-only)
├── .gitignore                     # node_modules/, dist/, .<name>/, *.tgz, *.log
├── LICENSE                        # MIT, current year, "Marcus Markiewicz"
├── README.md                      # title + quick-start + commands + structure
├── package.json                   # see schema below
├── tsconfig.json                  # ES2022 / Node16 / strict, src -> dist
├── eslint.config.js               # curly:all, brace-style 1tbs, indent:2
├── src/
│   ├── cli.ts                     # commander entry, reads version from package.json
│   └── commands/
│       └── doctor.ts              # starter health check (CheckResult shape)
└── test/
    ├── run.mjs                    # cross-platform glob runner with HOME sandbox
    ├── tsconfig.json              # extends root, noEmit, includes src + test
    ├── unit/
    │   ├── smoke.test.ts          # passing smoke test
    │   └── doctor.test.ts         # doctor module loads
    └── integration/               # (initially empty)
```

### package.json schema

```json
{
  "name": "<name>",
  "version": "0.1.0",
  "description": "<one-liner>",
  "type": "module",
  "bin": { "<bin>": "./dist/cli.js" },
  "scripts": {
    "prebuild": "eslint src/ test/ && tsc --noEmit -p test/tsconfig.json",
    "build": "tsc",
    "test": "node test/run.mjs test/**/*.test.ts",
    "test:unit": "node test/run.mjs test/unit/**/*.test.ts",
    "test:integration": "node test/run.mjs test/integration/**/*.test.ts",
    "lint": "eslint src/ test/ && tsc --noEmit && tsc --noEmit -p test/tsconfig.json",
    "clean": "node -e \"require('fs').rmSync('dist',{recursive:true,force:true})\"",
    "prepublishOnly": "npm run build"
  },
  "license": "MIT",
  "engines": { "node": ">=24.0.0" },
  "dependencies": {
    "chalk": "^5.4.1",
    "commander": "^13.1.0",
    "zod": "^3.24.4"
  },
  "devDependencies": {
    "@eslint/js": "^9.18.0",
    "@types/node": "^24.12.3",
    "eslint": "^9.18.0",
    "globals": "^15.14.0",
    "minimatch": "^10.0.1",
    "tsx": "^4.21.0",
    "typescript": "^5.7.0",
    "typescript-eslint": "^8.20.0"
  }
}
```

Windows-only repos additionally get `"os": ["win32"]`.

### tsconfig.json (root)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "test"]
}
```

### eslint.config.js

Flat-config ESLint with `@eslint/js` recommended + `typescript-eslint` recommended, plus three style rules that enforce block-style control flow:

- `curly: ["error", "all"]` — every `if`/`for`/`while`/`do` body must be braced
- `brace-style: ["error", "1tbs", { allowSingleLine: false }]` — no `if (x) { foo(); }` one-liners; body goes on its own line
- `indent: ["error", 2, { SwitchCase: 1 }]` — keeps autofixed blocks readable

`npm run build` runs `prebuild` first, so ESLint and test type errors fail the build before emit. `npm run lint` runs `eslint src/ test/` first, then the two `tsc --noEmit` passes. Autofix with `npx eslint . --fix`.

### test/run.mjs invariants

The runner enforces test hermeticity. The next editor must preserve:

- **HOME sandbox.** `HOME`, `USERPROFILE`, and `LOCALAPPDATA` are pointed at a
  tmpdir so tests cannot read the developer's real `~/.<name>/` state. Opt-out
  via `<NAME>_TEST_REAL_HOME=1` (uppercased, hyphens → underscores).
- **No `node --test` worker subprocesses.** `--test`'s IPC pipe intermittently
  fails on Windows runners with "Unable to deserialize cloned data" errors.
  The runner uses `node --import tsx --test-reporter=tap <file>` so node:test
  auto-starts in-process. Do not switch back to `--test`.
- **TAP aggregation.** The runner parses `# tests/# pass/# fail` lines from
  each file's TAP output and prints a single `# AGGREGATE` summary, then
  exits non-zero if any file failed.

### CI workflow

Default: Ubuntu + Windows matrix on Node 24. With `--windows-only`,
single-OS Windows job. Both run `npm ci` → `npm run lint` → `npm test`.

## Execution Sequence

1. **Confirm inputs.** Get name (kebab-case) and description from the user.
   Ask whether the repo is Windows-only.
2. **Run the scaffolder.** Single call to `node create-repo.js …`.
3. **Read the script's output.** The smoke test must pass. If `npm install` or
   `npm test` fails, do not proceed — fix the underlying environment issue
   (Node version, npm registry auth) instead of patching the scaffold.
4. **Report back.** Print the path, the `npm link` command, and the
   `gh repo create` command. Do not auto-publish to GitHub.

## Variants the scaffolder does NOT generate

Two cases the base scaffolder doesn't cover end-to-end. **Read
[`references/publishing-and-extension-repos/README.md`](references/publishing-and-extension-repos/README.md)
before assembling either:**

- **Copilot CLI extension repo.** Different shape from the standard CLI:
  `plugin.json` + `.github/extensions/<name>/extension.mjs` + install shim +
  setup skill. Mirror DamianEdwards/copilot-cli-cost; reference implementation
  is supermem613/copilot-cli-autopilot. The extension dev-loop has a sharp
  edge — junctions and symlinks on `~/.copilot/extensions/<name>/` are
  silently skipped by Copilot CLI's loader; use a one-line shim file instead.
- **Publishing to GitHub.** The base scaffolder prints the `gh repo create`
  command but does not run it. Before publishing, check `gh auth status` —
  the active account is often the Microsoft EMU (`marcusm_microsoft`), which
  cannot create repos under personal users; switch to `supermem613` first.
  Push remains a separately confirmed step (per the global identity rules)
  even when the user said "commit and push" in one message.

## Anti-Patterns

- **Hand-writing package.json.** Every divergence from the template ("oh I'll
  just use vitest this time") fragments the conventions across repos. If a
  template needs to change, change `scripts/create-repo.js`, not one repo.
- **Skipping `npm test` after scaffold.** The smoke test is the proof that all
  the parts agree. A scaffold that "looks right" but fails the smoke test ships
  a broken template to the next user.
- **Auto-creating the GitHub repo.** The user owns visibility (public/private)
  and remote name. Print the `gh repo create` command; do not run it.
- **Reusing kash's `.github/` layout.** Kash carries Microsoft-internal
  compliance/policies/JIT files. New OSS repos use only `.github/workflows/`.

## Cross-Platform Notes

- `scripts/create-repo.js` is Node-only (no shell-specific commands, no deps).
- The scaffolded `clean` script uses `node -e "require('fs').rmSync(...)"`
  instead of `rm -rf` so it works on Windows.
- The `test/run.mjs` template normalises path separators with
  `.split("\\").join("/")` before matching globs.
- **Node 20.12+ `.cmd` spawn quirk** (reflux learning, still applies on Node 24):
  when a future command in this repo spawns `.cmd` targets on Windows, pass
  `shell: true` to `child_process.spawn`/`execFile` — without it the process exits
  with the CVE-2024-27980 mitigation error. The scaffold itself doesn't trip this;
  flag it for any contributor adding shell-out commands.
- **Liberal identifier validation.** GitHub usernames can contain underscores
  (e.g. `marcusm_microsoft`), so avoid `[a-z0-9-]+`-only regexes when accepting
  user/org-style inputs in commands you add later.

## Convention Highlights

These are conventions the scaffold encodes; future commands you add to a
scaffolded repo should preserve them.

- **`doctor` ships in v0.1.0.** Every CLI has a structured health check.
  Shape: `interface CheckResult { name; ok; detail; hint? }`. Failed checks
  carry a `hint` with copy-paste remediation. Supports `--json`.
- **Bare-run prints version + help.** Running the CLI with no args
  prints `<bin> v<version>` followed by the full help (matches
  rotunda/kash/reflux). `<bin> --help` and `<bin> --version` keep
  commander's default behavior. The version banner is *not* printed
  before sub-commands so machine-parseable output (e.g. `<bin> doctor
  --json`) stays clean. The scaffold's `cli.ts` template includes the
  bare-run check before `program.parseAsync`.
- **`--json` machine output.** Any command that produces stdout output should
  accept `--json` for scriptable consumption (uatu, sp-tools, kash convention).
- **Plan → preview → confirm → apply.** State-mutating commands (anything that
  writes to disk or pushes remote) compute the full plan first, render a
  preview, ask `Proceed? [y/N]`, then apply. Silent auto-apply is the anti-
  pattern that nearly torpedoed rotunda's first sync UX (see ROTUNDA POR).
- **State file is source of truth** for any sync/cache. Empty-state corner
  cases (fresh install) are the dangerous ones — handle explicitly.
- **Lean dep ethos.** 3 runtime deps default. Every addition is a code-review
  conversation. Prefer Node built-ins.

## Output Format

After scaffolding, print:

```
Scaffolded <name> at <path>
  Files: <N>
  Smoke test: <N> passed
Next:
  cd <path>
  npm link        # make `<bin>` available globally
  gh repo create <name> --public --source=. --remote=origin --push
```
