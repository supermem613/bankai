#!/usr/bin/env node
/**
 * create-repo.js — Scaffold a new TypeScript Node CLI repo under ~/repos/<name>/.
 *
 * Conventions encoded here are derived from rotunda, kash, reflux:
 *   - ESM ("type": "module"), Node 24+, TypeScript strict, target ES2022, Node16 modules.
 *   - Source in src/, build output in dist/, CLI entry src/cli.ts -> dist/cli.js.
 *   - One file per command in src/commands/.
 *   - Cross-platform tests in test/ via run.mjs (HOME-sandboxed, tsx + node:test + TAP).
 *   - GitHub Actions CI on Ubuntu + Windows (or Windows-only with --windows-only).
 *   - MIT license, copyright Marcus Markiewicz, current year.
 *
 * Cross-platform: Node.js built-ins only, no external deps.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const USAGE = `
Usage:
  node create-repo.js <name> --description "<one-liner>" [options]

Required:
  <name>                  Repo name (kebab-case). Becomes the directory and package name.
  --description "<text>"  One-line description used in package.json and README.

Options:
  --bin <name>            CLI binary name (default: <name>).
  --windows-only          CI matrix is Windows-only; package.json gets "os": ["win32"].
  --repos-dir <path>      Parent directory for the repo (default: ~/repos).
  --no-install            Skip "npm install" and "npm run build".
  --no-git                Skip "git init".
  --license-year <year>   Year for LICENSE (default: current year).
  --author <name>         Author name (default: "Marcus Markiewicz").
  --help                  Show this help.

Example:
  node create-repo.js widget --description "Frobnicates widgets at scale"
`.trim();

function parseArgs(argv) {
  const out = { positional: [], opts: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help') { out.opts.help = true; continue; }
    if (a === '--windows-only') { out.opts.windowsOnly = true; continue; }
    if (a === '--no-install') { out.opts.noInstall = true; continue; }
    if (a === '--no-git') { out.opts.noGit = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[++i];
      if (val === undefined || val.startsWith('--')) {
        throw new Error(`Missing value for --${key}`);
      }
      out.opts[key] = val;
      continue;
    }
    out.positional.push(a);
  }
  return out;
}

function assert(cond, msg) {
  if (!cond) { throw new Error(msg); }
}

function validName(name) {
  return /^[a-z][a-z0-9-]*[a-z0-9]$/.test(name) && name.length <= 40;
}

// --- Templates (functions returning string) ---

function tplPackageJson({ name, description, bin, windowsOnly, author }) {
  const pkg = {
    name,
    version: '0.1.0',
    description,
    type: 'module',
    bin: { [bin]: './dist/cli.js' },
    scripts: {
      prebuild: 'eslint src/ test/ && tsc --noEmit -p test/tsconfig.json',
      build: 'tsc',
      test: 'node test/run.mjs test/**/*.test.ts',
      'test:unit': 'node test/run.mjs test/unit/**/*.test.ts',
      'test:integration': 'node test/run.mjs test/integration/**/*.test.ts',
      lint: 'eslint src/ test/ && tsc --noEmit && tsc --noEmit -p test/tsconfig.json',
      clean: "node -e \"require('fs').rmSync('dist',{recursive:true,force:true})\"",
      prepublishOnly: 'npm run build',
    },
    keywords: [],
    author,
    license: 'MIT',
    engines: { node: '>=24.0.0' },
    ...(windowsOnly ? { os: ['win32'] } : {}),
    // Lean is a feature: keep runtime deps small (rotunda holds the line at 4).
    // chalk for color, commander for CLI, zod for input validation.
    dependencies: {
      chalk: '^5.4.1',
      commander: '^13.1.0',
      zod: '^3.24.4',
    },
    devDependencies: {
      '@eslint/js': '^9.18.0',
      '@types/node': '^24.12.3',
      eslint: '^9.18.0',
      globals: '^15.14.0',
      minimatch: '^10.0.1',
      tsx: '^4.21.0',
      typescript: '^5.7.0',
      'typescript-eslint': '^8.20.0',
    },
  };
  return JSON.stringify(pkg, null, 2) + '\n';
}

function tplTsconfig() {
  return JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'Node16',
      moduleResolution: 'Node16',
      outDir: './dist',
      rootDir: './src',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      resolveJsonModule: true,
      declaration: true,
      declarationMap: true,
      sourceMap: true,
      types: ['node'],
    },
    include: ['src/**/*.ts'],
    exclude: ['node_modules', 'dist', 'test'],
  }, null, 2) + '\n';
}

function tplEslintConfig() {
  // Mirrors the kash convention: block-style control flow with consistent
  // indentation. curly:all forces braces; brace-style with allowSingleLine:false
  // forces the body onto its own line; indent:2 keeps autofixed blocks readable.
  return `import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "curly": ["error", "all"],
      "brace-style": ["error", "1tbs", { allowSingleLine: false }],
      "indent": ["error", 2, { SwitchCase: 1 }],
    },
  },
  {
    ignores: ["dist/", "node_modules/"],
  },
);
`;
}

function tplTestTsconfig() {
  return JSON.stringify({
    extends: '../tsconfig.json',
    compilerOptions: {
      rootDir: '..',
      noEmit: true,
      types: ['node'],
    },
    include: ['**/*.ts', '../src/**/*.ts'],
    exclude: ['../node_modules', '../dist'],
  }, null, 2) + '\n';
}

function tplGitignore({ name }) {
  return [
    'node_modules/',
    'dist/',
    `.${name}/`,
    '*.tgz',
    '*.log',
    '',
  ].join('\n');
}

function tplLicense({ year, author }) {
  return `MIT License

Copyright (c) ${year} ${author}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
}

function tplReadme({ name, description, bin, windowsOnly }) {
  const ciBadge = windowsOnly ? 'Windows' : 'Ubuntu + Windows';
  return `# ${name}

> ${description}

## Quick start

\`\`\`bash
git clone https://github.com/<you>/${name}.git ~/repos/${name}
cd ~/repos/${name}
npm install
npm run build
npm link    # makes \`${bin}\` available globally
\`\`\`

## Commands

\`\`\`bash
${bin} --help
${bin} doctor          # health check (use --json for machine output)
\`\`\`

## Conventions

- **Lean deps.** Runtime deps stay small (currently 3: chalk, commander, zod).
  Add a runtime dep only with a clear reason — every dep is supply-chain risk.
- **\`doctor\` first.** Every CLI ships a \`doctor\` command that returns
  \`CheckResult[]\` (name, ok, detail, hint). Hints carry remediation text.
- **\`--json\` everywhere.** Any command that produces output supports
  \`--json\` for machine-readable mode.
- **Plan → preview → confirm → apply** for any command that mutates state on
  disk or remote. Silent auto-apply is an anti-pattern.

## Development

\`\`\`bash
npm run build               # lint + test type-check -> tsc -> dist/
npm run lint                # type-check (src + test)
npm test                    # all tests
npm run test:unit           # unit only
npm run test:integration    # integration only
npm run clean               # remove dist/
\`\`\`

CI runs on ${ciBadge} via GitHub Actions (\`.github/workflows/ci.yml\`).

## Project structure

\`\`\`
src/
  cli.ts              # Entry point — Commander.js program
  commands/           # One file per CLI command
test/
  run.mjs             # Cross-platform test runner (HOME-sandboxed)
  tsconfig.json       # Test type-check config
  unit/               # Unit tests (*.test.ts)
  integration/        # Integration tests (*.test.ts)
\`\`\`

## License

MIT
`;
}

function tplCli({ name, bin, description }) {
  return `#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { doctorCommand } from "./commands/doctor.js";

// Read version from package.json so it stays in sync with the published version.
const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const VERSION = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string }).version;

const program = new Command();

program
  .name("${bin}")
  .description("${description.replace(/"/g, '\\"')}")
  .version(VERSION);

program
  .command("doctor")
  .description("Health check: verify environment and configuration")
  .option("--json", "Emit machine-readable JSON instead of human output")
  .action(doctorCommand);

// Add more commands here, e.g.:
//   import { helloCommand } from "./commands/hello.js";
//   program.command("hello").description("Say hello").action(helloCommand);

// Bare \`${bin}\` (no args) prints version + full help. Matches the
// rotunda/kash/reflux convention. No version banner before sub-commands
// so machine-parseable output stays clean.
if (process.argv.slice(2).length === 0) {
  process.stdout.write(\`${bin} v\${VERSION}\\n\\n\`);
  program.outputHelp();
  process.exit(0);
}

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
`;
}

function tplDoctor({ name, bin }) {
  return `import chalk from "chalk";

// CheckResult shape is the convention across rotunda/reflux/kash/sp-tools.
// Keep it stable: tooling and \`--json\` consumers depend on it.
export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

function checkNode(): CheckResult {
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (major < 24) {
    return {
      name: "node",
      ok: false,
      detail: \`Node \${process.versions.node} (need >=24)\`,
      hint: "Install Node 24 or later from https://nodejs.org",
    };
  }
  return { name: "node", ok: true, detail: \`Node \${process.versions.node}\` };
}

async function runChecks(): Promise<CheckResult[]> {
  return [
    checkNode(),
    // Add more checks here. Pattern: each check is a pure function returning
    // CheckResult. Failures should always carry a \`hint\` with remediation.
  ];
}

export async function doctorCommand(opts: { json?: boolean }): Promise<void> {
  const results = await runChecks();
  const allOk = results.every((r) => r.ok);

  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: allOk, checks: results }, null, 2) + "\\n");
    process.exit(allOk ? 0 : 1);
  }

  console.log(chalk.bold(\`${bin} doctor\\n\`));
  for (const r of results) {
    const icon = r.ok ? chalk.green("✓") : chalk.red("✗");
    console.log(\`  \${icon} \${r.name.padEnd(20, ".")} \${r.detail}\`);
    if (!r.ok && r.hint) {
      console.log(\`      \${chalk.dim(r.hint)}\`);
    }
  }
  console.log();
  console.log(allOk ? chalk.green("All checks passed.") : chalk.red("One or more checks failed."));
  process.exit(allOk ? 0 : 1);
}
`;
}

function tplTestRunner({ name }) {
  const envVar = name.toUpperCase().replace(/-/g, '_') + '_TEST_REAL_HOME';
  return `// Cross-platform test runner — expands glob and passes files to node --test.
// Sandboxes HOME/USERPROFILE to a tmpdir so tests cannot read the developer's
// real ~/.${name}/ state, mirroring CI exactly. Set ${envVar}=1 to opt out.
//
// Avoids \`node --test\` worker subprocesses (their IPC pipe intermittently
// fails on Windows runners with deserialize errors). Uses node:test auto-start
// in a single process with a TAP reporter for the aggregate summary.
import { readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { minimatch } from "minimatch";
import { execSync } from "node:child_process";

const pattern = process.argv[2] || "test/**/*.test.ts";
const baseDir = pattern.split(/[/\\\\]/)[0] || ".";
const allFiles = readdirSync(baseDir, { recursive: true })
  .map((f) => join(baseDir, f).split("\\\\").join("/"))
  .filter((f) => minimatch(f, pattern));

if (allFiles.length === 0) {
  console.error(\`No test files found matching: \${pattern}\`);
  process.exit(1);
}

const sandboxHome = process.env.${envVar}
  ? null
  : mkdtempSync(join(tmpdir(), "${name}-test-home-"));

const env = { ...process.env };
if (sandboxHome) {
  env.HOME = sandboxHome;
  env.USERPROFILE = sandboxHome;
  env.LOCALAPPDATA = join(sandboxHome, "AppData", "Local");
}

let exitCode = 0;
let totalTests = 0;
let totalPass = 0;
let totalFail = 0;
const failedFiles = [];
try {
  for (const file of allFiles) {
    const cmd = \`node --import tsx --test-reporter=tap \${file}\`;
    let stdout = "";
    let fileFailed = false;
    try {
      stdout = execSync(cmd, { env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    } catch (err) {
      fileFailed = true;
      stdout = (err.stdout ?? "").toString();
      failedFiles.push(file);
    }
    process.stdout.write(stdout);
    const tests = parseInt((stdout.match(/^# tests (\\d+)/m) ?? [])[1] ?? "0", 10);
    const pass  = parseInt((stdout.match(/^# pass (\\d+)/m)  ?? [])[1] ?? "0", 10);
    const fail  = parseInt((stdout.match(/^# fail (\\d+)/m)  ?? [])[1] ?? "0", 10);
    totalTests += tests;
    totalPass += pass;
    totalFail += fail;
    if (fileFailed && fail === 0) {
      totalFail += 1;
    }
  }
  console.log(\`\\n# AGGREGATE: tests \${totalTests} | pass \${totalPass} | fail \${totalFail}\`);
  if (failedFiles.length) {
    console.log(\`# Failed files:\\n\${failedFiles.map((f) => \`#   \${f}\`).join("\\n")}\`);
    exitCode = 1;
  }
} finally {
  if (sandboxHome) {
    rmSync(sandboxHome, { recursive: true, force: true });
  }
}
process.exit(exitCode);
`;
}

function tplCi({ windowsOnly }) {
  if (windowsOnly) {
    return `name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build-and-test:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "24"
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npm run lint
      - run: npm test
`;
  }
  return `name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
        node-version: [24]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node-version }}
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm test
`;
}

function tplSampleTest({ name }) {
  return `import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

describe("${name}", () => {
  it("loads", () => {
    assert.equal(1 + 1, 2);
  });
});
`;
}

function tplDoctorTest({ name }) {
  return `import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

// Smoke test: doctor module loads and runChecks-style shape is intact.
// Real environment checks belong in test/integration/.
describe("doctor", () => {
  it("imports without error", async () => {
    const mod = await import("../../src/commands/doctor.js");
    assert.equal(typeof mod.doctorCommand, "function");
  });
});
`;
}

// --- Main ---

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2));
  if (opts.help || positional.length === 0) {
    console.log(USAGE);
    process.exit(opts.help ? 0 : 1);
  }
  const name = positional[0];
  assert(validName(name),
    `Invalid name "${name}". Use kebab-case: lowercase letters, digits, hyphens (e.g. "my-tool").`);
  assert(opts.description, 'Missing required --description "<text>".');

  const bin = opts.bin || name;
  const windowsOnly = !!opts.windowsOnly;
  const reposDir = opts['repos-dir'] || path.join(os.homedir(), 'repos');
  const repoDir = path.join(reposDir, name);
  const year = opts['license-year'] || String(new Date().getFullYear());
  const author = opts.author || 'Marcus Markiewicz';

  assert(!fs.existsSync(repoDir), `Target already exists: ${repoDir}`);

  console.log(`Scaffolding ${name} at ${repoDir}`);
  fs.mkdirSync(repoDir, { recursive: true });

  const ctx = { name, description: opts.description, bin, windowsOnly, author };
  const files = {
    'package.json':                 tplPackageJson(ctx),
    'tsconfig.json':                tplTsconfig(),
    'eslint.config.js':             tplEslintConfig(),
    '.gitignore':                   tplGitignore(ctx),
    'LICENSE':                      tplLicense({ year, author }),
    'README.md':                    tplReadme(ctx),
    'src/cli.ts':                   tplCli(ctx),
    'src/commands/doctor.ts':       tplDoctor(ctx),
    'test/run.mjs':                 tplTestRunner(ctx),
    'test/tsconfig.json':           tplTestTsconfig(),
    'test/unit/smoke.test.ts':      tplSampleTest(ctx),
    'test/unit/doctor.test.ts':     tplDoctorTest(ctx),
    'test/integration/.gitkeep':    '',
    '.github/workflows/ci.yml':     tplCi({ windowsOnly }),
  };

  for (const [rel, content] of Object.entries(files)) {
    writeFile(path.join(repoDir, rel), content);
  }
  console.log(`Wrote ${Object.keys(files).length} files.`);

  const run = (cmd) => {
    console.log(`$ ${cmd}`);
    execSync(cmd, { cwd: repoDir, stdio: 'inherit' });
  };

  if (!opts.noGit) {
    run('git init -b main');
  }
  if (!opts.noInstall) {
    run('npm install');
    run('npm run build');
    run('npm test');
  }

  console.log(`\nDone. Next:`);
  console.log(`  cd ${repoDir}`);
  if (opts.noInstall) console.log(`  npm install && npm run build`);
  console.log(`  npm link        # make \`${bin}\` available globally`);
  console.log(`  # then create the GitHub repo and push:`);
  console.log(`  gh repo create ${name} --public --source=. --remote=origin --push`);
}

try {
  main();
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
