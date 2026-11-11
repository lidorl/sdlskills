---
feat_req: docs/feat-req/pluggable-doc-store.md
design: docs/design/pluggable-doc-store.md
status: PLANNED
date: 2026-09-15
plan: 1 of 2
repos: [sdlskills]
---

# Pluggable doc store — Plan 1: Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `doc-store.yml` schema, the `GitDocStore` / `JiraConfluenceDocStore` abstraction, and the `sync-doc.mjs` CLI as standalone, fully tested tooling that nothing in the lifecycle consumes yet.

**Architecture:** `scripts/lib/doc-store-config.mjs` parses/validates `doc-store.yml` (absent file ⇒ `{ store: 'git' }`, zero behavior change). `scripts/lib/doc-store.mjs` exposes `getDocStore(config)` → `GitDocStore` (true no-op) or `JiraConfluenceDocStore` (JIRA REST v3 / Confluence REST v2 over built-in `fetch`, HTTP Basic Auth). `scripts/lib/sync-state.mjs` hashes content and diagnoses `first-sync | in-sync | local-ahead | remote-ahead | conflict` against a git-ignored sidecar (`workspace/.sync-state/`). `scripts/lib/frontmatter.mjs` reads/writes flat frontmatter fields. `scripts/sync-doc.mjs push|pull <file>` wires all four together — the CLI entry point later skills will shell out to.

**Tech Stack:** Node ≥18 (built-in `node:test`, `node:crypto`, `fetch`), the existing `yaml` dependency. **No new runtime dependency.**

**Spec:** `docs/design/pluggable-doc-store.md` (see also ADR 005)

## Global Constraints

- Node built-ins + the single existing dependency `yaml`. No new npm package (ADR 004 precedent — a second dependency needs its own ADR; this plan adds none).
- Scripts live in `scripts/` (or `scripts/lib/`), tests alongside as `*.test.mjs`, run with `node --test`.
- `store: git`, or no `doc-store.yml` at all, must be a **true no-op** at every layer: no network call, no file write, no `workspace/.sync-state/` entry created. This is the acceptance criterion "no configuration ⇒ no behavior change."
- The API token is never written to any tracked file. `doc-store.yml` holds only env-var *names* (`auth.email_env`, `auth.token_env`); values come from `process.env` at call time.
- A conflict (both local and remote changed since the last sync) always throws — never silently overwrite either side.
- `workspace/` is already in `.gitignore` (execution-environment Plan 1, Task 1) — `workspace/.sync-state/` is covered automatically; do not add a redundant `.gitignore` entry.

## Repositories

Single-repo effort — the kit itself.

| key | role | tier |
|---|---|---|
| `sdlskills` (this repo) | owner | standard |

## Repositories in scope

`sdlskills` — owns every change. No consumers.

---

### Task 1: `doc-store.yml` schema — template + `doc-store-config.mjs`

**Files:**
- Create: `doc-store.example.yml`
- Create: `scripts/lib/doc-store-config.mjs`
- Create: `scripts/lib/doc-store-config.test.mjs`

**Interfaces:**
- Produces:
  - `loadDocStoreConfig(rootDir) -> DocStoreConfig` — `{ store: 'git' }` when `doc-store.yml` is absent; otherwise the parsed+validated file. Throws `DocStoreConfigError` on invalid YAML or a schema violation.
  - `validateDocStoreConfig(obj) -> string[]` — human-readable problems, empty = valid.
  - `class DocStoreConfigError extends Error`
  - `DocStoreConfig = { store: 'git' } | { store: 'jira-confluence', jira: { base_url, project_key, issue_types? }, confluence: { base_url, space_key }, auth: { email_env, token_env } }`

- [ ] **Step 1: Write `doc-store.example.yml`**

```yaml
# doc-store.yml — optional. Absent (or `store: git`) = zero behavior change,
# every skill's existing git-only flow runs exactly as today.
# Consumed by: scripts/sync-doc.mjs, and (Plan 2) the write-feature-request /
# write-design-doc / write-execution-plan / select-next-task / close-out skills.
store: git   # git | jira-confluence

# Everything below only matters when store: jira-confluence.
jira:
  base_url: https://<your-org>.atlassian.net
  project_key: KIT
  issue_types:
    epic: Epic
    story: Story
    subtask: Sub-task
confluence:
  base_url: https://<your-org>.atlassian.net/wiki
  space_key: KIT

# Names of environment variables holding credentials — never the values
# themselves. Set these in your shell / CI secrets; never commit them.
auth:
  email_env: JIRA_EMAIL
  token_env: JIRA_API_TOKEN
```

- [ ] **Step 2: Write the failing test**

`scripts/lib/doc-store-config.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDocStoreConfig, validateDocStoreConfig, DocStoreConfigError } from './doc-store-config.mjs';

function withRoot(yaml) {
  const dir = mkdtempSync(join(tmpdir(), 'dsc-'));
  if (yaml !== undefined) writeFileSync(join(dir, 'doc-store.yml'), yaml);
  return dir;
}

test('no doc-store.yml → defaults to { store: "git" }', () => {
  const dir = withRoot(undefined);
  assert.deepEqual(loadDocStoreConfig(dir), { store: 'git' });
  rmSync(dir, { recursive: true });
});

test('store: git needs no jira/confluence config', () => {
  const dir = withRoot('store: git\n');
  assert.deepEqual(loadDocStoreConfig(dir), { store: 'git' });
  rmSync(dir, { recursive: true });
});

const JIRA_CONFLUENCE = `store: jira-confluence
jira:
  base_url: https://acme.atlassian.net
  project_key: KIT
  issue_types: { epic: Epic, story: Story, subtask: Sub-task }
confluence:
  base_url: https://acme.atlassian.net/wiki
  space_key: KIT
auth:
  email_env: JIRA_EMAIL
  token_env: JIRA_API_TOKEN
`;

test('a complete jira-confluence config loads', () => {
  const dir = withRoot(JIRA_CONFLUENCE);
  const cfg = loadDocStoreConfig(dir);
  assert.equal(cfg.jira.project_key, 'KIT');
  assert.equal(cfg.auth.token_env, 'JIRA_API_TOKEN');
  rmSync(dir, { recursive: true });
});

test('jira-confluence missing a required field throws DocStoreConfigError', () => {
  const dir = withRoot('store: jira-confluence\njira:\n  base_url: https://acme.atlassian.net\n');
  assert.throws(() => loadDocStoreConfig(dir), DocStoreConfigError);
  rmSync(dir, { recursive: true });
});

test('validateDocStoreConfig rejects an unknown store value', () => {
  const problems = validateDocStoreConfig({ store: 'sharepoint' });
  assert.ok(problems.some((p) => p.includes('store')));
});

test('invalid YAML throws DocStoreConfigError', () => {
  const dir = withRoot('store: [unterminated\n');
  assert.throws(() => loadDocStoreConfig(dir), DocStoreConfigError);
  rmSync(dir, { recursive: true });
});
```

- [ ] **Step 3: Run — verify it fails**

Run: `node --test scripts/lib/doc-store-config.test.mjs`
Expected: FAIL — `Cannot find module './doc-store-config.mjs'`.

- [ ] **Step 4: Implement `scripts/lib/doc-store-config.mjs`**

```js
/**
 * doc-store-config.mjs — parse and validate doc-store.yml. Absent file is
 * not an error: it means { store: 'git' }, the zero-behavior-change default.
 * See docs/design/pluggable-doc-store.md → "Proposed Design" §1.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export class DocStoreConfigError extends Error {}

const STORES = ['git', 'jira-confluence'];
const DEFAULT = { store: 'git' };

export function validateDocStoreConfig(obj) {
  const problems = [];
  if (!obj || typeof obj !== 'object') return ['doc-store.yml must be a YAML mapping'];
  if (!STORES.includes(obj.store)) {
    problems.push(`store: must be one of ${STORES.join(', ')} (got "${obj.store}")`);
  }
  if (obj.store === 'jira-confluence') {
    const jira = obj.jira || {};
    for (const f of ['base_url', 'project_key']) {
      if (!jira[f]) problems.push(`jira.${f}: required when store is "jira-confluence"`);
    }
    const confluence = obj.confluence || {};
    for (const f of ['base_url', 'space_key']) {
      if (!confluence[f]) problems.push(`confluence.${f}: required when store is "jira-confluence"`);
    }
    const auth = obj.auth || {};
    for (const f of ['email_env', 'token_env']) {
      if (!auth[f]) problems.push(`auth.${f}: required when store is "jira-confluence"`);
    }
  }
  return problems;
}

export function loadDocStoreConfig(rootDir) {
  const path = join(rootDir, 'doc-store.yml');
  if (!existsSync(path)) return { ...DEFAULT };
  let parsed;
  try {
    parsed = parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new DocStoreConfigError(`doc-store.yml is not valid YAML: ${err.message}`);
  }
  const problems = validateDocStoreConfig(parsed);
  if (problems.length) {
    throw new DocStoreConfigError(`doc-store.yml has ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);
  }
  return parsed;
}
```

- [ ] **Step 5: Run — verify pass**

Run: `node --test scripts/lib/doc-store-config.test.mjs`
Expected: 7 tests pass.

- [ ] **Step 6: Commit**

```bash
git add doc-store.example.yml scripts/lib/doc-store-config.mjs scripts/lib/doc-store-config.test.mjs
git commit -m "feat: doc-store.yml schema + loader/validator"
```

---

### Task 2: `frontmatter.mjs` — shared read/write helper

**Files:**
- Create: `scripts/lib/frontmatter.mjs`
- Create: `scripts/lib/frontmatter.test.mjs`

**Interfaces:**
- Produces:
  - `parseFrontmatter(text) -> { data: Record<string,string>, body: string, raw: string }`
  - `setFrontmatterField(text, key, value) -> string` — updates the key if present, appends it if not, adds a frontmatter block if the doc has none.

- [ ] **Step 1: Write the failing test**

`scripts/lib/frontmatter.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter, setFrontmatterField } from './frontmatter.mjs';

const DOC = `---
date: 2026-09-14
status: ACCEPTED
---

# Title

Body text.
`;

test('parseFrontmatter splits data and body', () => {
  const { data, body } = parseFrontmatter(DOC);
  assert.equal(data.status, 'ACCEPTED');
  assert.equal(data.date, '2026-09-14');
  assert.ok(body.startsWith('\n# Title'));
});

test('parseFrontmatter returns empty data when there is no frontmatter block', () => {
  const { data, body } = parseFrontmatter('# No frontmatter\n');
  assert.deepEqual(data, {});
  assert.equal(body, '# No frontmatter\n');
});

test('setFrontmatterField updates an existing key and preserves the rest', () => {
  const out = setFrontmatterField(DOC, 'status', 'DESIGNED');
  const { data, body } = parseFrontmatter(out);
  assert.equal(data.status, 'DESIGNED');
  assert.equal(data.date, '2026-09-14');
  assert.ok(body.startsWith('\n# Title'));
});

test('setFrontmatterField adds a new key when absent', () => {
  const out = setFrontmatterField(DOC, 'jira_key', 'KIT-42');
  const { data } = parseFrontmatter(out);
  assert.equal(data.jira_key, 'KIT-42');
});

test('setFrontmatterField adds a frontmatter block to a doc that has none', () => {
  const out = setFrontmatterField('# No frontmatter\n', 'jira_key', 'KIT-1');
  const { data, body } = parseFrontmatter(out);
  assert.equal(data.jira_key, 'KIT-1');
  assert.equal(body, '# No frontmatter\n');
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `node --test scripts/lib/frontmatter.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `scripts/lib/frontmatter.mjs`**

```js
/**
 * frontmatter.mjs — flat YAML-frontmatter read/write for docs/ artifacts.
 * Read side mirrors render-status.mjs's parser; write side is new, used by
 * sync-doc.mjs to stamp jira_key / confluence_page_id back into a file.
 */

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseFrontmatter(text) {
  const m = text.match(FM_RE);
  if (!m) return { data: {}, body: text, raw: '' };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (kv) data[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { data, body: text.slice(m[0].length), raw: m[1] };
}

export function setFrontmatterField(text, key, value) {
  const m = text.match(FM_RE);
  if (!m) {
    return `---\n${key}: ${value}\n---\n${text}`;
  }
  const lines = m[1].split(/\r?\n/);
  const idx = lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
  if (idx !== -1) lines[idx] = `${key}: ${value}`;
  else lines.push(`${key}: ${value}`);
  const newBlock = `---\n${lines.join('\n')}\n---\n`;
  return text.slice(0, m.index) + newBlock + text.slice(m.index + m[0].length);
}
```

- [ ] **Step 4: Run — verify pass**

Run: `node --test scripts/lib/frontmatter.test.mjs`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/frontmatter.mjs scripts/lib/frontmatter.test.mjs
git commit -m "feat: frontmatter.mjs — read/write flat frontmatter fields"
```

---

### Task 3: `sync-state.mjs` — content hash + conflict diagnosis

**Files:**
- Create: `scripts/lib/sync-state.mjs`
- Create: `scripts/lib/sync-state.test.mjs`

**Interfaces:**
- Produces:
  - `hashContent(text) -> string` (sha256 hex)
  - `syncStatePath(rootDir, artifactRelPath) -> string` — `<rootDir>/workspace/.sync-state/<artifactRelPath>.json`
  - `readSyncState(rootDir, artifactRelPath) -> { localHash, remoteUpdatedAt, remoteId } | null`
  - `writeSyncState(rootDir, artifactRelPath, state) -> void`
  - `diagnoseSync(storedState, { localHash, remoteUpdatedAt }) -> 'first-sync' | 'in-sync' | 'local-ahead' | 'remote-ahead' | 'conflict'`

- [ ] **Step 1: Write the failing test**

`scripts/lib/sync-state.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashContent, readSyncState, writeSyncState, diagnoseSync } from './sync-state.mjs';

test('hashContent is deterministic and content-sensitive', () => {
  assert.equal(hashContent('abc'), hashContent('abc'));
  assert.notEqual(hashContent('abc'), hashContent('abd'));
});

test('readSyncState returns null when no state file exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-'));
  assert.equal(readSyncState(dir, 'docs/feat-req/x.md'), null);
  rmSync(dir, { recursive: true });
});

test('writeSyncState then readSyncState round-trips', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-'));
  writeSyncState(dir, 'docs/feat-req/x.md', { localHash: 'h1', remoteUpdatedAt: 't1', remoteId: 'KIT-1' });
  assert.deepEqual(readSyncState(dir, 'docs/feat-req/x.md'), { localHash: 'h1', remoteUpdatedAt: 't1', remoteId: 'KIT-1' });
  rmSync(dir, { recursive: true });
});

test('diagnoseSync: no prior state → first-sync', () => {
  assert.equal(diagnoseSync(null, { localHash: 'h1', remoteUpdatedAt: 't1' }), 'first-sync');
});

test('diagnoseSync: neither side changed → in-sync', () => {
  const stored = { localHash: 'h1', remoteUpdatedAt: 't1' };
  assert.equal(diagnoseSync(stored, { localHash: 'h1', remoteUpdatedAt: 't1' }), 'in-sync');
});

test('diagnoseSync: only local changed → local-ahead', () => {
  const stored = { localHash: 'h1', remoteUpdatedAt: 't1' };
  assert.equal(diagnoseSync(stored, { localHash: 'h2', remoteUpdatedAt: 't1' }), 'local-ahead');
});

test('diagnoseSync: only remote changed → remote-ahead', () => {
  const stored = { localHash: 'h1', remoteUpdatedAt: 't1' };
  assert.equal(diagnoseSync(stored, { localHash: 'h1', remoteUpdatedAt: 't2' }), 'remote-ahead');
});

test('diagnoseSync: both changed → conflict', () => {
  const stored = { localHash: 'h1', remoteUpdatedAt: 't1' };
  assert.equal(diagnoseSync(stored, { localHash: 'h2', remoteUpdatedAt: 't2' }), 'conflict');
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `node --test scripts/lib/sync-state.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `scripts/lib/sync-state.mjs`**

```js
/**
 * sync-state.mjs — per-artifact sync state (content hash + remote
 * timestamp), used to detect a genuine edit conflict before push/pull
 * overwrites either side. State lives in a git-ignored sidecar under
 * workspace/, not in the artifact's own frontmatter, to keep docs clean.
 * See docs/design/pluggable-doc-store.md → "Proposed Design" §4.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function hashContent(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function syncStatePath(rootDir, artifactRelPath) {
  return join(rootDir, 'workspace', '.sync-state', `${artifactRelPath}.json`);
}

export function readSyncState(rootDir, artifactRelPath) {
  const p = syncStatePath(rootDir, artifactRelPath);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function writeSyncState(rootDir, artifactRelPath, state) {
  const p = syncStatePath(rootDir, artifactRelPath);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2));
}

export function diagnoseSync(storedState, { localHash, remoteUpdatedAt }) {
  if (!storedState) return 'first-sync';
  const localChanged = storedState.localHash !== localHash;
  const remoteChanged = remoteUpdatedAt != null && storedState.remoteUpdatedAt !== remoteUpdatedAt;
  if (localChanged && remoteChanged) return 'conflict';
  if (localChanged) return 'local-ahead';
  if (remoteChanged) return 'remote-ahead';
  return 'in-sync';
}
```

- [ ] **Step 4: Run — verify pass**

Run: `node --test scripts/lib/sync-state.test.mjs`
Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/sync-state.mjs scripts/lib/sync-state.test.mjs
git commit -m "feat: sync-state.mjs — content-hash conflict diagnosis"
```

---

### Task 4: `doc-store.mjs` — `GitDocStore` / `JiraConfluenceDocStore`

**Files:**
- Create: `scripts/lib/doc-store.mjs`
- Create: `scripts/lib/doc-store.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks (config is passed in by the caller).
- Produces:
  - `class GitDocStore` — `async push() -> { remoteId: null, url: null }`, `async pull() -> null`, `mapStatus(kitStatus) -> kitStatus`
  - `class JiraConfluenceDocStore` — `constructor({ config, email, token, fetchImpl? })`; `async push(artifactType, { remoteId?, title, body, kitStatus?, parentKey? }) -> { remoteId, url }`; `async pull(artifactType, remoteId) -> { body, status, updatedAt } | null`; `mapStatus(kitStatus) -> string`
  - `getDocStore(config, opts?: { email?, token?, fetchImpl? }) -> GitDocStore | JiraConfluenceDocStore` — throws when `store: jira-confluence` and neither `opts` nor `process.env[config.auth.*_env]` supplies credentials.

- [ ] **Step 1: Write the failing test**

`scripts/lib/doc-store.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitDocStore, JiraConfluenceDocStore, getDocStore } from './doc-store.mjs';

const CONFIG = {
  store: 'jira-confluence',
  jira: { base_url: 'https://acme.atlassian.net', project_key: 'KIT', issue_types: { epic: 'Epic', story: 'Story' } },
  confluence: { base_url: 'https://acme.atlassian.net/wiki', space_key: 'KIT' },
  auth: { email_env: 'DOC_STORE_TEST_EMAIL', token_env: 'DOC_STORE_TEST_TOKEN' },
};

function fakeFetch(routes) {
  return async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const route = routes.find((r) => r.method === method && r.test(url));
    if (!route) throw new Error(`fakeFetch: no route for ${method} ${url}`);
    return {
      ok: route.status < 300,
      status: route.status,
      json: async () => route.body,
      text: async () => JSON.stringify(route.body),
    };
  };
}

test('GitDocStore push/pull are true no-ops', async () => {
  const store = new GitDocStore();
  assert.deepEqual(await store.push('epic', { title: 'x' }), { remoteId: null, url: null });
  assert.equal(await store.pull('epic', 'KIT-1'), null);
});

test('getDocStore returns GitDocStore for "git" or an absent config', () => {
  assert.ok(getDocStore({ store: 'git' }) instanceof GitDocStore);
  assert.ok(getDocStore(undefined) instanceof GitDocStore);
});

test('getDocStore throws when jira-confluence credentials are not available', () => {
  assert.throws(() => getDocStore(CONFIG, {}), /DOC_STORE_TEST_EMAIL/);
});

test('getDocStore returns a JiraConfluenceDocStore when credentials are passed explicitly', () => {
  const store = getDocStore(CONFIG, {
    email: 'a@b.com',
    token: 't',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  });
  assert.ok(store instanceof JiraConfluenceDocStore);
});

test('push creates a new JIRA issue when there is no remoteId', async () => {
  const fetchImpl = fakeFetch([
    { method: 'POST', test: (u) => u.endsWith('/rest/api/3/issue'), status: 201, body: { key: 'KIT-1' } },
  ]);
  const store = new JiraConfluenceDocStore({ config: CONFIG, email: 'a@b.com', token: 't', fetchImpl });
  const result = await store.push('epic', { title: 'My Epic', body: 'desc' });
  assert.deepEqual(result, { remoteId: 'KIT-1', url: 'https://acme.atlassian.net/browse/KIT-1' });
});

test('push updates an existing issue and transitions its status', async () => {
  const fetchImpl = fakeFetch([
    { method: 'PUT', test: (u) => u.endsWith('/rest/api/3/issue/KIT-1'), status: 204, body: null },
    { method: 'GET', test: (u) => u.endsWith('/rest/api/3/issue/KIT-1/transitions'), status: 200, body: { transitions: [{ id: '31', to: { name: 'In Progress' } }] } },
    { method: 'POST', test: (u) => u.endsWith('/rest/api/3/issue/KIT-1/transitions'), status: 204, body: null },
  ]);
  const store = new JiraConfluenceDocStore({ config: CONFIG, email: 'a@b.com', token: 't', fetchImpl });
  const result = await store.push('epic', { remoteId: 'KIT-1', title: 't', body: 'd', kitStatus: 'IN_PROGRESS' });
  assert.equal(result.remoteId, 'KIT-1');
});

test('push creates a Confluence page for artifactType "confluence-page"', async () => {
  const fetchImpl = fakeFetch([
    { method: 'POST', test: (u) => u.endsWith('/api/v2/pages'), status: 201, body: { id: '999', _links: { webui: '/spaces/KIT/pages/999' } } },
  ]);
  const store = new JiraConfluenceDocStore({ config: CONFIG, email: 'a@b.com', token: 't', fetchImpl });
  const result = await store.push('confluence-page', { title: 'Design', body: '<p>hi</p>' });
  assert.deepEqual(result, { remoteId: '999', url: 'https://acme.atlassian.net/wiki/spaces/KIT/pages/999' });
});

test('pull returns body/status/updatedAt for a JIRA issue', async () => {
  const fetchImpl = fakeFetch([
    { method: 'GET', test: (u) => u.endsWith('/rest/api/3/issue/KIT-1'), status: 200, body: { fields: { description: 'd', status: { name: 'Done' }, updated: '2026-09-15T00:00:00Z' } } },
  ]);
  const store = new JiraConfluenceDocStore({ config: CONFIG, email: 'a@b.com', token: 't', fetchImpl });
  const result = await store.pull('epic', 'KIT-1');
  assert.deepEqual(result, { body: 'd', status: 'Done', updatedAt: '2026-09-15T00:00:00Z' });
});

test('pull returns body/updatedAt for a Confluence page', async () => {
  const fetchImpl = fakeFetch([
    { method: 'GET', test: (u) => u.includes('/api/v2/pages/999'), status: 200, body: { body: { storage: { value: '<p>hi</p>' } }, version: { createdAt: '2026-09-15T00:00:00Z' } } },
  ]);
  const store = new JiraConfluenceDocStore({ config: CONFIG, email: 'a@b.com', token: 't', fetchImpl });
  const result = await store.pull('confluence-page', '999');
  assert.deepEqual(result, { body: '<p>hi</p>', status: null, updatedAt: '2026-09-15T00:00:00Z' });
});

test('a non-ok response raises a descriptive error', async () => {
  const fetchImpl = fakeFetch([
    { method: 'POST', test: (u) => u.endsWith('/rest/api/3/issue'), status: 400, body: { errorMessages: ['bad request'] } },
  ]);
  const store = new JiraConfluenceDocStore({ config: CONFIG, email: 'a@b.com', token: 't', fetchImpl });
  await assert.rejects(() => store.push('epic', { title: 't', body: 'd' }), /400/);
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `node --test scripts/lib/doc-store.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `scripts/lib/doc-store.mjs`**

```js
/**
 * doc-store.mjs — the doc-store abstraction. GitDocStore is the default,
 * a true no-op (the file already is the artifact). JiraConfluenceDocStore
 * talks to JIRA REST v3 / Confluence REST v2 over the built-in `fetch`.
 * See docs/design/pluggable-doc-store.md → "Proposed Design".
 */

const DEFAULT_ISSUE_TYPES = { epic: 'Epic', story: 'Story', subtask: 'Sub-task' };

const STATUS_MAP = {
  ACCEPTED: 'To Do',
  DESIGNED: 'To Do',
  PLANNED: 'To Do',
  IN_PROGRESS: 'In Progress',
  IMPLEMENTED: 'Done',
};

export class GitDocStore {
  async push() {
    return { remoteId: null, url: null };
  }
  async pull() {
    return null;
  }
  mapStatus(kitStatus) {
    return kitStatus;
  }
}

export class JiraConfluenceDocStore {
  constructor({ config, email, token, fetchImpl }) {
    this.config = config;
    this.email = email;
    this.token = token;
    this.fetchImpl = fetchImpl ?? fetch;
  }

  mapStatus(kitStatus) {
    return STATUS_MAP[kitStatus] ?? 'To Do';
  }

  async _request(url, options = {}) {
    const auth = Buffer.from(`${this.email}:${this.token}`).toString('base64');
    const res = await this.fetchImpl(url, {
      ...options,
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...options.headers,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`doc-store request failed: ${options.method ?? 'GET'} ${url} → ${res.status} ${body}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async push(artifactType, { remoteId, title, body, kitStatus, parentKey } = {}) {
    if (artifactType === 'confluence-page') {
      return this._pushConfluencePage({ remoteId, title, body, parentKey });
    }
    return this._pushJiraIssue(artifactType, { remoteId, title, body, kitStatus, parentKey });
  }

  async _pushJiraIssue(artifactType, { remoteId, title, body, kitStatus, parentKey }) {
    const base = this.config.jira.base_url;
    const issueType = this.config.jira.issue_types?.[artifactType] ?? DEFAULT_ISSUE_TYPES[artifactType];
    if (!issueType) throw new Error(`doc-store: no jira issue type for artifact type "${artifactType}"`);

    const fields = {
      summary: title,
      description: body,
      project: { key: this.config.jira.project_key },
      issuetype: { name: issueType },
    };
    if (parentKey) fields.parent = { key: parentKey };

    let key = remoteId;
    if (!key) {
      const created = await this._request(`${base}/rest/api/3/issue`, {
        method: 'POST',
        body: JSON.stringify({ fields }),
      });
      key = created.key;
    } else {
      await this._request(`${base}/rest/api/3/issue/${key}`, {
        method: 'PUT',
        body: JSON.stringify({ fields }),
      });
    }

    if (kitStatus) await this._transition(key, this.mapStatus(kitStatus));
    return { remoteId: key, url: `${base}/browse/${key}` };
  }

  async _transition(key, targetStatusName) {
    const base = this.config.jira.base_url;
    const { transitions } = await this._request(`${base}/rest/api/3/issue/${key}/transitions`);
    const match = (transitions ?? []).find((t) => t.to.name === targetStatusName);
    if (!match) return;
    await this._request(`${base}/rest/api/3/issue/${key}/transitions`, {
      method: 'POST',
      body: JSON.stringify({ transition: { id: match.id } }),
    });
  }

  async _pushConfluencePage({ remoteId, title, body, parentKey }) {
    const base = this.config.confluence.base_url;
    const pageBody = { representation: 'storage', value: body };

    if (!remoteId) {
      const payload = { spaceId: this.config.confluence.space_key, status: 'current', title, body: pageBody };
      if (parentKey) payload.parentId = parentKey;
      const created = await this._request(`${base}/api/v2/pages`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      return { remoteId: created.id, url: `${base}${created._links?.webui ?? ''}` };
    }

    const current = await this._request(`${base}/api/v2/pages/${remoteId}`);
    const updated = await this._request(`${base}/api/v2/pages/${remoteId}`, {
      method: 'PUT',
      body: JSON.stringify({
        id: remoteId,
        status: 'current',
        title,
        body: pageBody,
        version: { number: current.version.number + 1 },
      }),
    });
    return { remoteId: updated.id, url: `${base}${updated._links?.webui ?? ''}` };
  }

  async pull(artifactType, remoteId) {
    if (!remoteId) return null;
    if (artifactType === 'confluence-page') {
      const base = this.config.confluence.base_url;
      const page = await this._request(`${base}/api/v2/pages/${remoteId}?body-format=storage`);
      return { body: page.body.storage.value, status: null, updatedAt: page.version.createdAt };
    }
    const base = this.config.jira.base_url;
    const issue = await this._request(`${base}/rest/api/3/issue/${remoteId}`);
    return { body: issue.fields.description, status: issue.fields.status.name, updatedAt: issue.fields.updated };
  }
}

export function getDocStore(config, opts = {}) {
  const cfg = config ?? { store: 'git' };
  if (cfg.store === 'git') return new GitDocStore();
  if (cfg.store === 'jira-confluence') {
    const email = opts.email ?? process.env[cfg.auth.email_env];
    const token = opts.token ?? process.env[cfg.auth.token_env];
    if (!email || !token) {
      throw new Error(`doc-store: env vars "${cfg.auth.email_env}" and/or "${cfg.auth.token_env}" are not set`);
    }
    return new JiraConfluenceDocStore({ config: cfg, email, token, fetchImpl: opts.fetchImpl });
  }
  throw new Error(`doc-store: unknown store "${cfg.store}"`);
}
```

- [ ] **Step 4: Run — verify pass**

Run: `node --test scripts/lib/doc-store.test.mjs`
Expected: 10 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/doc-store.mjs scripts/lib/doc-store.test.mjs
git commit -m "feat: doc-store.mjs — GitDocStore / JiraConfluenceDocStore"
```

---

### Task 5: `sync-doc.mjs` — the CLI skills will shell out to

**Files:**
- Create: `scripts/sync-doc.mjs`
- Create: `scripts/sync-doc.test.mjs`

**Interfaces:**
- Consumes: `loadDocStoreConfig` (Task 1), `getDocStore` (Task 4), `parseFrontmatter`/`setFrontmatterField` (Task 2), `hashContent`/`readSyncState`/`writeSyncState`/`diagnoseSync` (Task 3).
- Produces:
  - CLI: `node scripts/sync-doc.mjs push|pull <file> [--type epic|story|subtask|confluence-page] [--root <dir>]`
  - `syncPush({ rootDir, filePath, artifactType?, config?, store? }) -> { remoteId, url }`
  - `syncPull({ rootDir, filePath, artifactType?, config?, store? }) -> { changed: boolean, reason: string }`
  - Both accept an injectable `store` (bypassing `getDocStore`) for testing and a `config` override (bypassing `loadDocStoreConfig`).

- [ ] **Step 1: Write the failing test**

`scripts/sync-doc.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncPush, syncPull } from './sync-doc.mjs';
import { parseFrontmatter } from './lib/frontmatter.mjs';

function setup(bodyText) {
  const dir = mkdtempSync(join(tmpdir(), 'sd-'));
  const file = join(dir, 'thing.md');
  writeFileSync(file, bodyText);
  return { dir, file };
}

const DOC = `---
date: 2026-09-15
status: ACCEPTED
---

# Thing

Original body.
`;

function fakeStore() {
  let remoteId = null;
  let body = '';
  let seq = 0;
  return {
    async push(type, { remoteId: rid, body: b }) {
      remoteId = rid ?? 'KIT-1';
      body = b;
      seq += 1;
      return { remoteId, url: `https://example.atlassian.net/browse/${remoteId}` };
    },
    async pull() {
      if (!remoteId) return null;
      return { body, status: 'To Do', updatedAt: `t${seq}` };
    },
    _setRemoteBody(b) {
      body = b;
      seq += 1;
    },
  };
}

test('push is a true no-op for a "git" store config', async () => {
  const { dir, file } = setup(DOC);
  const before = readFileSync(file, 'utf8');
  const result = await syncPush({ rootDir: dir, filePath: file, artifactType: 'epic', config: { store: 'git' } });
  assert.deepEqual(result, { remoteId: null, url: null });
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.ok(!existsSync(join(dir, 'workspace', '.sync-state')));
  rmSync(dir, { recursive: true });
});

test('first push creates the remote and stamps jira_key into frontmatter', async () => {
  const { dir, file } = setup(DOC);
  const store = fakeStore();
  const result = await syncPush({ rootDir: dir, filePath: file, artifactType: 'epic', config: { store: 'jira-confluence' }, store });
  assert.equal(result.remoteId, 'KIT-1');
  const { data } = parseFrontmatter(readFileSync(file, 'utf8'));
  assert.equal(data.jira_key, 'KIT-1');
  rmSync(dir, { recursive: true });
});

test('a second push after only a local edit succeeds (local-ahead)', async () => {
  const { dir, file } = setup(DOC);
  const store = fakeStore();
  await syncPush({ rootDir: dir, filePath: file, artifactType: 'epic', config: { store: 'jira-confluence' }, store });
  writeFileSync(file, readFileSync(file, 'utf8').replace('Original body.', 'Edited body.'));
  const result = await syncPush({ rootDir: dir, filePath: file, artifactType: 'epic', config: { store: 'jira-confluence' }, store });
  assert.equal(result.remoteId, 'KIT-1');
  rmSync(dir, { recursive: true });
});

test('pull adopts a remote-only change', async () => {
  const { dir, file } = setup(DOC);
  const store = fakeStore();
  await syncPush({ rootDir: dir, filePath: file, artifactType: 'epic', config: { store: 'jira-confluence' }, store });
  store._setRemoteBody('\n# Thing\n\nEdited remotely.\n');
  const result = await syncPull({ rootDir: dir, filePath: file, artifactType: 'epic', config: { store: 'jira-confluence' }, store });
  assert.equal(result.changed, true);
  assert.ok(readFileSync(file, 'utf8').includes('Edited remotely.'));
  rmSync(dir, { recursive: true });
});

test('pull with no jira_key yet reports "not yet pushed"', async () => {
  const { dir, file } = setup(DOC);
  const store = fakeStore();
  const result = await syncPull({ rootDir: dir, filePath: file, artifactType: 'epic', config: { store: 'jira-confluence' }, store });
  assert.deepEqual(result, { changed: false, reason: 'not yet pushed' });
  rmSync(dir, { recursive: true });
});

test('a conflicting edit on both sides is refused, not silently overwritten', async () => {
  const { dir, file } = setup(DOC);
  const store = fakeStore();
  await syncPush({ rootDir: dir, filePath: file, artifactType: 'epic', config: { store: 'jira-confluence' }, store });
  writeFileSync(file, readFileSync(file, 'utf8').replace('Original body.', 'Local edit.'));
  store._setRemoteBody('\n# Thing\n\nRemote edit.\n');
  await assert.rejects(
    () => syncPull({ rootDir: dir, filePath: file, artifactType: 'epic', config: { store: 'jira-confluence' }, store }),
    /conflict/
  );
  rmSync(dir, { recursive: true });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `node --test scripts/sync-doc.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `scripts/sync-doc.mjs`**

```js
#!/usr/bin/env node
/**
 * sync-doc.mjs — push/pull one docs/ artifact through the configured doc
 * store. A true no-op when doc-store.yml selects (or defaults to) "git" —
 * no files touched, no workspace/.sync-state/ entry created.
 *
 * Usage:
 *   node scripts/sync-doc.mjs push <file> [--type epic|story|subtask|confluence-page] [--root <dir>]
 *   node scripts/sync-doc.mjs pull <file> [--type epic|story|subtask|confluence-page] [--root <dir>]
 *
 * See docs/design/pluggable-doc-store.md → "Proposed Design" §3-4.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { loadDocStoreConfig } from './lib/doc-store-config.mjs';
import { getDocStore } from './lib/doc-store.mjs';
import { parseFrontmatter, setFrontmatterField } from './lib/frontmatter.mjs';
import { hashContent, readSyncState, writeSyncState, diagnoseSync } from './lib/sync-state.mjs';

const REMOTE_ID_FIELD = { epic: 'jira_key', story: 'jira_key', subtask: 'jira_key', 'confluence-page': 'confluence_page_id' };

function relArtifactPath(rootDir, filePath) {
  return relative(rootDir, filePath).split('\\').join('/');
}

export async function syncPush({ rootDir, filePath, artifactType = 'epic', config, store }) {
  const cfg = config ?? loadDocStoreConfig(rootDir);
  if (cfg.store === 'git') return { remoteId: null, url: null };
  const docStore = store ?? getDocStore(cfg);
  const relPath = relArtifactPath(rootDir, filePath);
  const text = readFileSync(filePath, 'utf8');
  const { data, body } = parseFrontmatter(text);
  const remoteField = REMOTE_ID_FIELD[artifactType];
  const remoteId = remoteField ? data[remoteField] : undefined;
  const localHash = hashContent(text);
  const stored = readSyncState(rootDir, relPath);

  let remoteUpdatedAt = null;
  if (remoteId) {
    const remote = await docStore.pull(artifactType, remoteId);
    remoteUpdatedAt = remote?.updatedAt ?? null;
  }

  const diagnosis = diagnoseSync(stored, { localHash, remoteUpdatedAt });
  if (diagnosis === 'conflict') {
    throw new Error(`doc-store conflict: ${relPath} changed both locally and remotely since the last sync. Run pull to inspect the remote version, reconcile by hand, then push again.`);
  }
  if (diagnosis === 'remote-ahead') {
    throw new Error(`doc-store: ${relPath} changed remotely (not locally) since the last sync. Run pull instead of push.`);
  }

  const title = (text.match(/^#\s+(.+)$/m) || [])[1] || relPath;
  const result = await docStore.push(artifactType, { remoteId, title, body, kitStatus: data.status });

  let newText = text;
  if (remoteField && result.remoteId && result.remoteId !== remoteId) {
    newText = setFrontmatterField(newText, remoteField, result.remoteId);
    writeFileSync(filePath, newText);
  }

  const after = await docStore.pull(artifactType, result.remoteId);
  writeSyncState(rootDir, relPath, {
    localHash: hashContent(newText),
    remoteUpdatedAt: after?.updatedAt ?? remoteUpdatedAt,
    remoteId: result.remoteId,
  });
  return result;
}

export async function syncPull({ rootDir, filePath, artifactType = 'epic', config, store }) {
  const cfg = config ?? loadDocStoreConfig(rootDir);
  if (cfg.store === 'git') return { changed: false, reason: 'git store — no-op' };
  const docStore = store ?? getDocStore(cfg);
  const relPath = relArtifactPath(rootDir, filePath);
  const text = readFileSync(filePath, 'utf8');
  const { data, body } = parseFrontmatter(text);
  const remoteField = REMOTE_ID_FIELD[artifactType];
  const remoteId = remoteField ? data[remoteField] : undefined;
  if (!remoteId) return { changed: false, reason: 'not yet pushed' };

  const remote = await docStore.pull(artifactType, remoteId);
  if (!remote) return { changed: false, reason: 'nothing to pull' };

  const localHash = hashContent(text);
  const stored = readSyncState(rootDir, relPath);
  const diagnosis = diagnoseSync(stored, { localHash, remoteUpdatedAt: remote.updatedAt });

  if (diagnosis === 'conflict') {
    throw new Error(`doc-store conflict: ${relPath} changed both locally and remotely since the last sync. Reconcile by hand, then push (to force local) or pull again (to adopt remote).`);
  }
  if (diagnosis === 'in-sync' || diagnosis === 'local-ahead') {
    writeSyncState(rootDir, relPath, { localHash, remoteUpdatedAt: remote.updatedAt, remoteId });
    return { changed: false, reason: diagnosis };
  }

  const prefixLen = text.length - body.length;
  const newText = text.slice(0, prefixLen) + remote.body;
  writeFileSync(filePath, newText);
  writeSyncState(rootDir, relPath, { localHash: hashContent(newText), remoteUpdatedAt: remote.updatedAt, remoteId });
  return { changed: true, reason: diagnosis };
}

function main() {
  const [action, file, ...rest] = process.argv.slice(2);
  if (!action || !file || !['push', 'pull'].includes(action)) {
    console.error('usage: sync-doc.mjs push|pull <file> [--type epic|story|subtask|confluence-page] [--root <dir>]');
    process.exit(2);
  }
  const rootIx = rest.indexOf('--root');
  const rootDir = rootIx !== -1 ? rest[rootIx + 1] : process.cwd();
  const typeIx = rest.indexOf('--type');
  const artifactType = typeIx !== -1 ? rest[typeIx + 1] : 'epic';
  const filePath = resolve(rootDir, file);
  const run = action === 'push' ? syncPush : syncPull;
  run({ rootDir, filePath, artifactType })
    .then((r) => console.log(`sync-doc: ${action} ${file} →`, JSON.stringify(r)))
    .catch((err) => {
      console.error(`sync-doc: ${err.message}`);
      process.exit(1);
    });
}

if (import.meta.url === `file://${process.argv[1]}`) main();
```

- [ ] **Step 4: Run — verify pass**

Run: `node --test scripts/sync-doc.test.mjs`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync-doc.mjs scripts/sync-doc.test.mjs
git commit -m "feat: sync-doc.mjs — push/pull CLI through the doc-store abstraction"
```

---

### Task 6: Wire the example config into docs + full suite run

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:** none — documentation.

- [ ] **Step 1: Add a line to `README.md`** in the same table as the `repos.yml` row (see line ~54):

`| [`doc-store.yml`](doc-store.example.yml) | Optional — routes docs/ artifacts to JIRA + Confluence instead of git. Absent = git, unchanged. `doc-store.example.yml` is the annotated template. |`

- [ ] **Step 2: Add a line to `CLAUDE.md`** under the repo-contents list, alongside the `scripts/` bullets:

`- [`doc-store.example.yml`](doc-store.example.yml) — optional JIRA/Confluence doc-store config template (see [`docs/design/pluggable-doc-store.md`](docs/design/pluggable-doc-store.md)).`

- [ ] **Step 3: Confirm `workspace/.sync-state/` needs no separate `.gitignore` entry**

Run: `git check-ignore -v workspace/.sync-state/anything.json || echo "not ignored"`
Expected: matches the existing `workspace/` rule in `.gitignore` (added in execution-environment Plan 1, Task 1). If it prints "not ignored", add `workspace/` to `.gitignore` before continuing — it should already be there.

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: all tests from Tasks 1–5 pass alongside the existing catalog/assemble-env/clean-env/install-sdlc/render-status suites.

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: point to doc-store.example.yml"
```

---

## Pull Requests

N/A — single-repo effort (`sdlskills`), executed on `main` per this repo's own convention (see execution-environment Plan 1/2). Fill a `key | branch | PR | state` table here if this repo later adopts a PR workflow for its own changes.

## Self-Review

- **Spec coverage:** `doc-store.yml` schema ✓ (T1); `GitDocStore` no-op contract ✓ (T4, T5); `JiraConfluenceDocStore` push/pull for epics/stories/Confluence pages ✓ (T4); conflict detection (both-sides-changed → refuse, not overwrite) ✓ (T3, T5); credential handling via env-var names only, never committed ✓ (T1, T4); zero new dependency ✓ (built-in `fetch` throughout). Deferred to Plan 2: every skill integration point, `setup-sdlc` config step, `install-sdlc.mjs` vendoring, the optional migration script, `CLAUDE.process.md` prose.
- **Placeholders:** none — all code is inline and runnable as written.
- **Type consistency:** `loadDocStoreConfig` (T1) return shape consumed unchanged by `getDocStore` (T4) and `sync-doc.mjs` (T5). `push(artifactType, {...}) -> {remoteId, url}` / `pull(artifactType, remoteId) -> {body, status, updatedAt}|null` identical across `GitDocStore`, `JiraConfluenceDocStore`, and the `fakeStore` test doubles in T5. `diagnoseSync(storedState, {localHash, remoteUpdatedAt})` signature matches its only two call sites (both in `sync-doc.mjs`).

## Execution

REQUIRED SUB-SKILL: `superpowers:executing-plans` (or `subagent-driven-development`). T1–T4 are independent of each other; T5 depends on T1–T4; T6 depends on T5.
