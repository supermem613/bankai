# bankai

> Reliable orchestration engine for dev-loop and test plan execution with environment plugins

## Quick start

```bash
git clone https://github.com/<you>/bankai.git ~/repos/bankai
cd ~/repos/bankai
npm install
npm run build
npm link    # makes `bankai` available globally
```

## Commands

```bash
bankai --help
bankai doctor          # health check (use --json for machine output)
```

## Conventions

- **Lean deps.** Runtime deps stay small (currently 3: chalk, commander, zod).
  Add a runtime dep only with a clear reason — every dep is supply-chain risk.
- **`doctor` first.** Every CLI ships a `doctor` command that returns
  `CheckResult[]` (name, ok, detail, hint). Hints carry remediation text.
- **`--json` everywhere.** Any command that produces output supports
  `--json` for machine-readable mode.
- **Plan → preview → confirm → apply** for any command that mutates state on
  disk or remote. Silent auto-apply is an anti-pattern.

## Development

```bash
npm run build               # lint + test type-check -> tsc -> dist/
npm run lint                # type-check (src + test)
npm test                    # all tests
npm run test:unit           # unit only
npm run test:integration    # integration only
npm run clean               # remove dist/
```

CI runs on Ubuntu + Windows via GitHub Actions (`.github/workflows/ci.yml`).

## Project structure

```
src/
  cli.ts              # Entry point — Commander.js program
  commands/           # One file per CLI command
test/
  run.mjs             # Cross-platform test runner (HOME-sandboxed)
  tsconfig.json       # Test type-check config
  unit/               # Unit tests (*.test.ts)
  integration/        # Integration tests (*.test.ts)
```

## License

MIT
