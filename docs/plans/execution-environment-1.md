---
feat_req: docs/feat-req/execution-environment.md
design: docs/design/execution-environment.md
status: PLANNED
date: 2026-09-09
plan: 1 of 2
repos: [sdlskills]
---

# Multi-repo execution environment — Plan 1: Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the catalog format and the `assemble-env` / `clean-env` scripts as standalone, tested tooling that nothing in the lifecycle consumes yet.

**Architecture:** A `scripts/lib/catalog.mjs` module parses and validates `repos.yml` (via the `yaml` dependency). `scripts/assemble-env.mjs` reconstructs `workspace/` from a design doc's `repos:` list — idempotent, shallow clones, per-effort branch, `.current-effort` marker. `scripts/clean-env.mjs` removes checkouts. Tests use `node:test` with local `git init --bare` fixtures as fake remotes.

**Tech Stack:** Node ≥18 (built-in `node:test`, `node:fs`, `node:child_process`), one dependency `yaml`, `git` CLI.

**Spec:** `docs/design/execution-environment.md` (see also ADR 001, ADR 004)

## Global Constraints

- Node built-ins + `git`/`gh` shell-outs + the single dependency `yaml`. No other npm packages (ADR 004 — a second dependency needs its own ADR).
- Scripts live in `scripts/`, tests alongside as `scripts/**/*.test.mjs`, run with `node --test`.
- Path references in any doc use `<key>:<repo-relative-path>`; a bare path means the meta-root.
- `assemble-env.mjs` must refuse clone URLs that are not `https://…` or `git@…`.
- This repo (`sdlskills`) is not currently a git repo and has no `package.json`; Task 1 creates the `package.json`. Commits: this plan assumes the executor initialises git if needed, or commits are no-ops until then — do not block on it.

## Repositories

Single-repo effort — the kit itself is the only repo in play. `repos.yml` / `workspace/` do not apply to this plan's own execution (they are its deliverables).

| key | role | tier |
|---|---|---|
| `sdlskills` (this repo) | owner | standard |

## Repositories in scope

`sdlskills` — the kit repo. Owns every change. No consumers (the kit has no downstream repos).

---

### Task 1: Meta-root `package.json` + `yaml` + test scaffold

**Files:**
- Create: `package.json`
- Create: `scripts/lib/.gitkeep`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `npm test` → `node --test scripts/`; `yaml` importable as `import { parse } from 'yaml'`

- [x] **Step 1: Create `package.json`**

```json
{
  "name": "sdlskills-meta-root",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test scripts/",
    "status": "node scripts/render-status.mjs"
  },
  "dependencies": {
    "yaml": "^2.5.0"
  }
}
```

- [x] **Step 2: Install**

Run: `npm install`
Expected: `yaml` in `node_modules/`, `package-lock.json` created.

- [x] **Step 3: Add `node_modules/` and `workspace/` to `.gitignore`**

Append to `.gitignore`:

```
node_modules/
workspace/
```

(`docs/STATUS.md` and `docs/.status.json` are already ignored.)

- [x] **Step 4: Smoke-test the runner**

Create `scripts/lib/smoke.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';

test('yaml dependency loads and parses', () => {
  assert.deepEqual(parse('a: 1\nb: [x, y]'), { a: 1, b: ['x', 'y'] });
});
```

- [x] **Step 5: Run**

Run: `npm test`
Expected: 1 test, pass.

- [x] **Step 6: Delete the smoke test, commit**

```bash
rm scripts/lib/smoke.test.mjs
git add package.json package-lock.json .gitignore scripts/lib/.gitkeep
git commit -m "chore: meta-root package.json + yaml dep + test runner"
```

---

### Task 2: `repos.yml` catalog — schema doc + `catalog.mjs`

**Files:**
- Create: `repos.example.yml`
- Create: `repos/README.md`
- Create: `scripts/lib/catalog.mjs`
- Create: `scripts/lib/catalog.test.mjs`

**Interfaces:**
- Produces:
  - `loadCatalog(rootDir) -> { repos: Record<string, RepoEntry> }` — reads `<rootDir>/repos.yml`, throws `CatalogError` with a readable message on any schema violation or missing file.
  - `RepoEntry = { url: string, default_branch: string, domain: string, summary: string, responsibilities: string[], depends_on: string[], keywords: string[], notes: boolean }`
  - `validateCatalog(obj) -> string[]` — returns a list of human-readable problems (empty = valid). `loadCatalog` calls this and throws if non-empty.
  - `class CatalogError extends Error`

- [x] **Step 1: Write `repos.example.yml`**

```yaml
# repos.yml — repository catalog. One entry per repo the project works across.
# Consumed by: scripts/assemble-env.mjs, the Design phase (repo selection), select-next-task.
repos:
  api:
    url: https://github.com/acme/api.git
    default_branch: main
    domain: backend
    summary: >
      The core HTTP API. Owns offers, claims, and vendor/game auth.
      NestJS + Prisma + Postgres. All external fulfilment traffic lands here.
    responsibilities:
      - Offer and claim lifecycle
      - Vendor and game API-key validation
      - The public OpenAPI contract
    depends_on: [shared-types]
    keywords: [offers, claims, fulfilment, api-key, endpoint]
    notes: false
  web:
    url: https://github.com/acme/web.git
    default_branch: main
    domain: frontend
    summary: >
      The admin console. Vite + React + shadcn/ui. Talks to `api` only.
    responsibilities:
      - Vendor, game, and offer management screens
    depends_on: [api, shared-types]
    keywords: [admin, console, ui, dashboard]
    notes: true
  shared-types:
    url: https://github.com/acme/shared-types.git
    default_branch: main
    domain: shared-lib
    summary: >
      TypeScript types shared between `api` and `web`. Published to the
      internal registry; both consumers pin a version.
    responsibilities:
      - Request/response DTO types
    depends_on: []
    keywords: [types, dto, contract]
    notes: false
```

- [x] **Step 2: Write `repos/README.md`**

```markdown
# Repository notes

One file per repo (`<key>.md`) that needs more context than its `repos.yml`
`summary` gives. The Design phase reads these when it can't tell from
`repos.yml` alone whether a repo is in scope for an effort.

Set `notes: true` on the repo's `repos.yml` entry when a file here exists.

Suggested sections: Architecture · Entry points (`<key>:path`) · Conventions
· Gotchas · How to run and test.
```

- [x] **Step 3: Write the failing test**

`scripts/lib/catalog.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalog, validateCatalog, CatalogError } from './catalog.mjs';

function withRoot(yaml) {
  const dir = mkdtempSync(join(tmpdir(), 'cat-'));
  if (yaml !== undefined) writeFileSync(join(dir, 'repos.yml'), yaml);
  return dir;
}

const VALID = `repos:
  api:
    url: https://github.com/acme/api.git
    default_branch: main
    domain: backend
    summary: The API.
    responsibilities: [offers]
`;

test('loads a valid catalog and fills defaults', () => {
  const dir = withRoot(VALID);
  const cat = loadCatalog(dir);
  assert.equal(cat.repos.api.url, 'https://github.com/acme/api.git');
  assert.deepEqual(cat.repos.api.depends_on, []);
  assert.deepEqual(cat.repos.api.keywords, []);
  assert.equal(cat.repos.api.notes, false);
  rmSync(dir, { recursive: true });
});

test('missing repos.yml throws CatalogError', () => {
  const dir = withRoot(undefined);
  assert.throws(() => loadCatalog(dir), CatalogError);
  rmSync(dir, { recursive: true });
});

test('missing required field is reported', () => {
  const problems = validateCatalog({ repos: { api: { url: 'https://x.git' } } });
  assert.ok(problems.some((p) => p.includes('api') && p.includes('default_branch')));
  assert.ok(problems.some((p) => p.includes('api') && p.includes('domain')));
});

test('non-https/ssh url is rejected', () => {
  const problems = validateCatalog({
    repos: { api: { url: 'file:///tmp/x', default_branch: 'main', domain: 'backend', summary: 's', responsibilities: ['r'] } },
  });
  assert.ok(problems.some((p) => p.includes('url')));
});

test('empty responsibilities is rejected', () => {
  const problems = validateCatalog({
    repos: { api: { url: 'https://x.git', default_branch: 'main', domain: 'backend', summary: 's', responsibilities: [] } },
  });
  assert.ok(problems.some((p) => p.includes('responsibilities')));
});

test('depends_on referencing an unknown key is reported', () => {
  const problems = validateCatalog({
    repos: { api: { url: 'https://x.git', default_branch: 'main', domain: 'backend', summary: 's', responsibilities: ['r'], depends_on: ['ghost'] } },
  });
  assert.ok(problems.some((p) => p.includes('ghost')));
});
```

- [x] **Step 4: Run — verify it fails**

Run: `node --test scripts/lib/catalog.test.mjs`
Expected: FAIL — `Cannot find module './catalog.mjs'`.

- [x] **Step 5: Implement `scripts/lib/catalog.mjs`**

```js
/**
 * catalog.mjs — parse and validate repos.yml (the repository catalog).
 * See docs/design/execution-environment.md → "Repository catalog".
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export class CatalogError extends Error {}

const REQUIRED = ['url', 'default_branch', 'domain', 'summary', 'responsibilities'];
const URL_RE = /^(https:\/\/|git@)/;

export function validateCatalog(obj) {
  const problems = [];
  if (!obj || typeof obj !== 'object' || !obj.repos || typeof obj.repos !== 'object') {
    return ['top-level `repos:` map is missing'];
  }
  const keys = Object.keys(obj.repos);
  for (const key of keys) {
    const e = obj.repos[key] || {};
    for (const f of REQUIRED) {
      if (e[f] === undefined || e[f] === null || e[f] === '') {
        problems.push(`repos.${key}: missing required field \`${f}\``);
      }
    }
    if (e.url && !URL_RE.test(String(e.url))) {
      problems.push(`repos.${key}: \`url\` must start with https:// or git@ (got "${e.url}")`);
    }
    if (e.responsibilities !== undefined) {
      if (!Array.isArray(e.responsibilities) || e.responsibilities.length === 0) {
        problems.push(`repos.${key}: \`responsibilities\` must be a non-empty list`);
      }
    }
    for (const dep of e.depends_on ?? []) {
      if (!keys.includes(dep)) {
        problems.push(`repos.${key}: \`depends_on\` references unknown repo "${dep}"`);
      }
    }
  }
  return problems;
}

function normalise(obj) {
  const repos = {};
  for (const [key, e] of Object.entries(obj.repos)) {
    repos[key] = {
      url: e.url,
      default_branch: e.default_branch,
      domain: e.domain,
      summary: String(e.summary).trim(),
      responsibilities: e.responsibilities,
      depends_on: e.depends_on ?? [],
      keywords: e.keywords ?? [],
      notes: e.notes ?? false,
    };
  }
  return { repos };
}

export function loadCatalog(rootDir) {
  const path = join(rootDir, 'repos.yml');
  if (!existsSync(path)) {
    throw new CatalogError(`repos.yml not found at ${path}. Run /setup-sdlc to create it.`);
  }
  let parsed;
  try {
    parsed = parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new CatalogError(`repos.yml is not valid YAML: ${err.message}`);
  }
  const problems = validateCatalog(parsed);
  if (problems.length) {
    throw new CatalogError(`repos.yml has ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);
  }
  return normalise(parsed);
}
```

- [x] **Step 6: Run — verify pass**

Run: `node --test scripts/lib/catalog.test.mjs`
Expected: 6 tests pass.

- [x] **Step 7: Commit**

```bash
git add repos.example.yml repos/README.md scripts/lib/catalog.mjs scripts/lib/catalog.test.mjs
git commit -m "feat: repos.yml catalog schema + loader/validator"
```

---

### Task 3: `assemble-env.mjs`

**Files:**
- Create: `scripts/assemble-env.mjs`
- Create: `scripts/assemble-env.test.mjs`

**Interfaces:**
- Consumes: `loadCatalog` from `scripts/lib/catalog.mjs`
- Produces: CLI `node scripts/assemble-env.mjs <effort-slug> [<extra-repo-key> ...] [--root <dir>]`
  - Resolves repo keys: from `docs/design/<effort-slug>.md` frontmatter `repos:` (a `[a, b]` list), plus any extra keys passed as args.
  - Exported for tests: `resolveRepoKeys(rootDir, slug, extraKeys) -> string[]`, `assemble({ rootDir, slug, keys, catalog }) -> { cloned: string[], fetched: string[], branch: string }`

- [x] **Step 1: Write the failing test**

`scripts/assemble-env.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRepoKeys, assemble } from './assemble-env.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });

function bareRemote(dir, name) {
  const remote = join(dir, `${name}.git`);
  mkdirSync(remote);
  git(remote, 'init', '--bare', '-b', 'main');
  const work = join(dir, `seed-${name}`);
  mkdirSync(work);
  git(work, 'init', '-b', 'main');
  git(work, '-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init');
  git(work, 'remote', 'add', 'origin', remote);
  git(work, 'push', 'origin', 'main');
  return remote;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'asm-'));
  const apiRemote = bareRemote(dir, 'api');
  const webRemote = bareRemote(dir, 'web');
  const root = join(dir, 'root');
  mkdirSync(join(root, 'docs', 'design'), { recursive: true });
  writeFileSync(join(root, 'repos.yml'), `repos:
  api:
    url: ${apiRemote}
    default_branch: main
    domain: backend
    summary: api
    responsibilities: [x]
  web:
    url: ${webRemote}
    default_branch: main
    domain: frontend
    summary: web
    responsibilities: [x]
`);
  writeFileSync(join(root, 'docs', 'design', 'thing.md'),
    `---\nfeat_req: docs/feat-req/thing.md\nrepos: [api]\nstatus: APPROVED\n---\n# Thing\n`);
  return { dir, root };
}

test('resolveRepoKeys reads the design doc repos list plus extras', () => {
  const { dir, root } = setup();
  assert.deepEqual(resolveRepoKeys(root, 'thing', ['web']).sort(), ['api', 'web']);
  rmSync(dir, { recursive: true });
});

test('assemble clones missing repos on the effort branch and writes the marker', () => {
  const { dir, root } = setup();
  const r = assemble({ rootDir: root, slug: 'thing', keys: ['api'] });
  assert.deepEqual(r.cloned, ['api']);
  assert.equal(r.branch, 'feat/thing');
  assert.ok(existsSync(join(root, 'workspace', 'api', '.git')));
  assert.equal(
    execFileSync('git', ['branch', '--show-current'], { cwd: join(root, 'workspace', 'api') }).toString().trim(),
    'feat/thing'
  );
  assert.equal(readFileSync(join(root, 'workspace', '.current-effort'), 'utf8').trim(), 'thing');
  rmSync(dir, { recursive: true });
});

test('assemble is idempotent — second run fetches, does not re-clone', () => {
  const { dir, root } = setup();
  assemble({ rootDir: root, slug: 'thing', keys: ['api'] });
  const r2 = assemble({ rootDir: root, slug: 'thing', keys: ['api'] });
  assert.deepEqual(r2.cloned, []);
  assert.deepEqual(r2.fetched, ['api']);
  rmSync(dir, { recursive: true });
});

test('assemble warns and reassembles when .current-effort names another effort', () => {
  const { dir, root } = setup();
  assemble({ rootDir: root, slug: 'thing', keys: ['api'] });
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', '.current-effort'), 'other\n');
  const r = assemble({ rootDir: root, slug: 'thing', keys: ['api'] });
  assert.equal(readFileSync(join(root, 'workspace', '.current-effort'), 'utf8').trim(), 'thing');
  assert.ok(r.warnings.some((w) => w.includes('other')));
  rmSync(dir, { recursive: true });
});

test('a non-https/ssh url is refused', () => {
  const { dir, root } = setup();
  writeFileSync(join(root, 'repos.yml'), `repos:
  api:
    url: file:///tmp/evil
    default_branch: main
    domain: backend
    summary: s
    responsibilities: [x]
`);
  assert.throws(() => assemble({ rootDir: root, slug: 'thing', keys: ['api'] }), /https:\/\/ or git@/);
  rmSync(dir, { recursive: true });
});
```

- [x] **Step 2: Run — verify it fails**

Run: `node --test scripts/assemble-env.test.mjs`
Expected: FAIL — module not found.

- [x] **Step 3: Implement `scripts/assemble-env.mjs`**

```js
#!/usr/bin/env node
/**
 * assemble-env.mjs — reconstruct workspace/ for an effort. Idempotent.
 * See docs/design/execution-environment.md → "Scripts".
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadCatalog } from './lib/catalog.mjs';

const URL_RE = /^(https:\/\/|git@)/;
const git = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

export function resolveRepoKeys(rootDir, slug, extraKeys = []) {
  const keys = new Set(extraKeys);
  const design = join(rootDir, 'docs', 'design', `${slug}.md`);
  if (existsSync(design)) {
    const fm = readFileSync(design, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const line = fm && fm[1].match(/^repos:\s*\[(.*)\]\s*$/m);
    if (line) line[1].split(',').map((s) => s.trim()).filter(Boolean).forEach((k) => keys.add(k));
  }
  return [...keys];
}

export function assemble({ rootDir, slug, keys, catalog }) {
  const cat = catalog ?? loadCatalog(rootDir);
  const branch = `feat/${slug}`;
  const wsDir = join(rootDir, 'workspace');
  mkdirSync(wsDir, { recursive: true });

  const warnings = [];
  const markerPath = join(wsDir, '.current-effort');
  if (existsSync(markerPath)) {
    const current = readFileSync(markerPath, 'utf8').trim();
    if (current && current !== slug) {
      const others = readdirSync(wsDir).filter((d) => !d.startsWith('.'));
      warnings.push(`workspace/ was assembled for "${current}" (${others.join(', ')}); reassembling for "${slug}". Stale checkouts left in place — run clean-env.mjs to remove.`);
    }
  }

  const cloned = [], fetched = [];
  for (const key of keys) {
    const entry = cat.repos[key];
    if (!entry) throw new Error(`repos.yml has no entry for "${key}"`);
    if (!URL_RE.test(entry.url)) throw new Error(`repos.${key}: url must be https:// or git@ (got "${entry.url}")`);
    const dest = join(wsDir, key);
    if (!existsSync(join(dest, '.git'))) {
      execFileSync('git', ['clone', '--depth', '1', entry.url, dest], { stdio: ['ignore', 'pipe', 'pipe'] });
      cloned.push(key);
    } else {
      git(dest, ['fetch', 'origin']);
      fetched.push(key);
    }
    const branches = git(dest, ['branch', '--list', branch]).trim();
    if (branches) git(dest, ['checkout', branch]);
    else git(dest, ['checkout', '-b', branch]);
  }

  writeFileSync(markerPath, `${slug}\n`);
  return { cloned, fetched, branch, warnings };
}

function main() {
  const args = process.argv.slice(2);
  const rootIx = args.indexOf('--root');
  const rootDir = rootIx !== -1 ? args[rootIx + 1] : process.cwd();
  const positional = args.filter((a, i) => a !== '--root' && args[i - 1] !== '--root');
  const [slug, ...extra] = positional;
  if (!slug) {
    console.error('usage: assemble-env.mjs <effort-slug> [<extra-repo-key> ...] [--root <dir>]');
    process.exit(2);
  }
  const keys = resolveRepoKeys(rootDir, slug, extra);
  if (!keys.length) {
    console.error(`no repos for "${slug}" — no docs/design/${slug}.md repos: list and no keys given`);
    process.exit(2);
  }
  const r = assemble({ rootDir, slug, keys });
  r.warnings.forEach((w) => console.warn(`warning: ${w}`));
  console.log(`assemble-env: ${slug} on ${r.branch} — cloned [${r.cloned.join(', ')}] fetched [${r.fetched.join(', ')}]`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
```

- [x] **Step 4: Run — verify pass**

Run: `node --test scripts/assemble-env.test.mjs`
Expected: 5 tests pass.

- [x] **Step 5: Commit**

```bash
git add scripts/assemble-env.mjs scripts/assemble-env.test.mjs
git commit -m "feat: assemble-env.mjs — idempotent workspace reconstruction"
```

---

### Task 4: `clean-env.mjs`

**Files:**
- Create: `scripts/clean-env.mjs`
- Create: `scripts/clean-env.test.mjs`

**Interfaces:**
- Produces: CLI `node scripts/clean-env.mjs [<key> ...] [--force] [--root <dir>]`; exported `clean({ rootDir, keys, force }) -> { removed: string[], skipped: string[] }`
  - No keys → all checkouts. `skipped` = checkouts with un-pushed commits or a dirty tree (unless `--force`).
  - Clears `.current-effort` when `workspace/` has no repo dirs left.

- [x] **Step 1: Write the failing test**

`scripts/clean-env.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clean } from './clean-env.mjs';

const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });

function wsRepo(root, key, { dirty = false } = {}) {
  const dir = join(root, 'workspace', key);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-b', 'main');
  git(dir, '-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init');
  if (dirty) writeFileSync(join(dir, 'x.txt'), 'uncommitted');
  return dir;
}

test('clean removes a clean checkout and clears the marker when empty', () => {
  const root = mkdtempSync(join(tmpdir(), 'cln-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', '.current-effort'), 'thing\n');
  wsRepo(root, 'api');
  const r = clean({ rootDir: root, keys: [], force: false });
  assert.deepEqual(r.removed, ['api']);
  assert.ok(!existsSync(join(root, 'workspace', 'api')));
  assert.ok(!existsSync(join(root, 'workspace', '.current-effort')));
  rmSync(root, { recursive: true });
});

test('clean skips a dirty checkout without --force', () => {
  const root = mkdtempSync(join(tmpdir(), 'cln-'));
  wsRepo(root, 'api', { dirty: true });
  const r = clean({ rootDir: root, keys: [], force: false });
  assert.deepEqual(r.skipped, ['api']);
  assert.ok(existsSync(join(root, 'workspace', 'api')));
  rmSync(root, { recursive: true });
});

test('clean --force removes a dirty checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'cln-'));
  wsRepo(root, 'api', { dirty: true });
  const r = clean({ rootDir: root, keys: [], force: true });
  assert.deepEqual(r.removed, ['api']);
  rmSync(root, { recursive: true });
});
```

- [x] **Step 2: Run — verify it fails**

Run: `node --test scripts/clean-env.test.mjs`
Expected: FAIL — module not found.

- [x] **Step 3: Implement `scripts/clean-env.mjs`**

```js
#!/usr/bin/env node
/**
 * clean-env.mjs — remove workspace/ checkouts. See execution-environment.md → "Scripts".
 */
import { existsSync, readdirSync, rmSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

function isProtected(dir) {
  try {
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir, stdio: 'pipe' }).toString().trim();
    if (status) return true;
    const unpushed = execFileSync('git', ['log', '--branches', '--not', '--remotes', '--oneline'], { cwd: dir, stdio: 'pipe' }).toString().trim();
    return Boolean(unpushed);
  } catch {
    return false; // not a git repo → nothing to protect
  }
}

export function clean({ rootDir, keys = [], force = false }) {
  const wsDir = join(rootDir, 'workspace');
  if (!existsSync(wsDir)) return { removed: [], skipped: [] };
  const present = readdirSync(wsDir).filter((d) => !d.startsWith('.'));
  const targets = keys.length ? keys.filter((k) => present.includes(k)) : present;

  const removed = [], skipped = [];
  for (const key of targets) {
    const dir = join(wsDir, key);
    if (!force && isProtected(dir)) { skipped.push(key); continue; }
    rmSync(dir, { recursive: true, force: true });
    removed.push(key);
  }

  const left = readdirSync(wsDir).filter((d) => !d.startsWith('.'));
  const marker = join(wsDir, '.current-effort');
  if (!left.length && existsSync(marker)) unlinkSync(marker);

  return { removed, skipped };
}

function main() {
  const args = process.argv.slice(2);
  const rootIx = args.indexOf('--root');
  const rootDir = rootIx !== -1 ? args[rootIx + 1] : process.cwd();
  const force = args.includes('--force');
  const keys = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--root');
  const r = clean({ rootDir, keys, force });
  console.log(`clean-env: removed [${r.removed.join(', ')}]${r.skipped.length ? ` — skipped (uncommitted work, use --force) [${r.skipped.join(', ')}]` : ''}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
```

- [x] **Step 4: Run — verify pass**

Run: `node --test scripts/clean-env.test.mjs`
Expected: 3 tests pass.

- [x] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all tests from Tasks 2–4 pass.

- [x] **Step 6: Commit**

```bash
git add scripts/clean-env.mjs scripts/clean-env.test.mjs
git commit -m "feat: clean-env.mjs — remove workspace checkouts, protect uncommitted work"
```

---

### Task 5: Wire the example catalog + README pointer

**Files:**
- Create: `repos.yml` (copy of `repos.example.yml`, for this repo's own dogfooding — single `sdlskills` entry)
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:** none — documentation.

- [x] **Step 1: Create a real `repos.yml` for this repo**

```yaml
# repos.yml — this kit dogfoods itself. Single-repo (N=1).
repos:
  sdlskills:
    url: https://github.com/lidorl/sdlskills.git
    default_branch: main
    domain: shared-lib
    summary: >
      The SDLC kit itself — process contract, phase skills, and the scripts
      that support them. No application code.
    responsibilities:
      - The lifecycle definition (CLAUDE.process.md)
      - The phase skills under skills/
      - The support scripts under scripts/
    depends_on: []
    keywords: [kit, skills, process, lifecycle]
    notes: false
```

(Note: `workspace/` is git-ignored; `assemble-env.mjs` against this repo is a no-op safety net, not a real use — the kit is edited in place.)

- [x] **Step 2: Add a line to `README.md`**

Under "What's in this repo", add:
`| `repos.yml` / `repos/` | The repository catalog — which repo does what (see the execution-environment feature). |`

- [x] **Step 3: Add a line to `CLAUDE.md`**

Under the repo-contents list:
`- [`repos.yml`](repos.yml) / [`repos/`](repos/) — the repository catalog (multi-repo execution environment).`

- [x] **Step 4: Commit**

```bash
git add repos.yml README.md CLAUDE.md
git commit -m "docs: add repository catalog + example"
```

---

## Pull Requests

N/A — single-repo effort (`sdlskills`), executed on `main` during kit bootstrap. No PR workflow yet; commits land directly. Real multi-repo efforts fill a `key | branch | PR | state` table here.

## Self-Review

- **Spec coverage:** `repos.yml` schema ✓ (T2); `assemble-env` idempotent + branch + marker + mismatch + url-refusal ✓ (T3); `clean-env` ✓ (T4); `yaml` dep + `package.json` ✓ (T1); `.gitignore` `workspace/` ✓ (T1). Deferred to Plan 2: every skill change, `CLAUDE.process.md` prose, `render-status.mjs` PR parsing, `setup-sdlc` interview.
- **Placeholders:** none — all code is inline.
- **Type consistency:** `loadCatalog`/`validateCatalog`/`CatalogError` (T2) consumed unchanged by `assemble-env.mjs` (T3). `assemble({rootDir, slug, keys, catalog})` / `clean({rootDir, keys, force})` signatures match their tests.

## Execution

REQUIRED SUB-SKILL: `superpowers:executing-plans` (or `subagent-driven-development`). Tasks are independent enough for subagent-per-task; T3 depends on T2, T5 depends on T2.
