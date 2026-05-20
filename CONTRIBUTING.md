# Contributing

## Development setup

```bash
npm install
npm run build
npm test
```

Bankai requires Node.js 22 or newer.

## Quality bar

- Keep plans schema-validated and bounded by explicit timeouts.
- Keep runtime dependencies lean.
- Do not persist secrets, full environment blocks, or full command output in
  registry state.
- Prefer generic steps, assertions, readiness probes, and tools over
  product-specific integrations.
- Update README, bundled skills, and `.audit-repo.yaml` when the public CLI
  surface changes.
- Keep `bankai update` envelope-first. It should not print progress prose that
  agents need to parse.

## Pull requests

Before opening a pull request, run:

```bash
npm run build
npm test
npm pack --dry-run
```

The package tarball should contain the built CLI, bundled skills, README, and
license only.
