---
feat_req: docs/feat-req/pluggable-doc-store.md
design: docs/design/pluggable-doc-store.md
status: PLANNED
date: 2026-09-15
plan: 2 of 2
repos: [sdlskills]
---

# Pluggable doc store — Plan 2: Lifecycle integration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Plan 1 foundation (`doc-store.yml`, `getDocStore`, `sync-doc.mjs`) into every phase of the lifecycle, so an adopter who opts in gets Epics/Stories/Confluence pages automatically, and an adopter who doesn't sees no change at all.

**Architecture:** Edits to the phase skills under `skills/`, `scripts/install-sdlc.mjs`, and `CLAUDE.process.md`, plus a new adopter-invoked `scripts/migrate-docs-to-store.mjs`. Each skill gains one new, `store`-conditional step calling `syncPush`/`syncPull` from Plan 1.

**Tech Stack:** Markdown (skill files), Node (`migrate-docs-to-store.mjs`, `install-sdlc.mjs` diff).

**Spec:** `docs/design/pluggable-doc-store.md` — see "Proposed Design" §6 (skill integration table) and §7 (migration tool). Requires Plan 1 merged.

## Global Constraints

- Every new step is conditional on `doc-store.yml` selecting `jira-confluence` — for `store: git` (or no file), the step is a no-op and the skill's existing behavior is untouched. This is the acceptance criterion "no configuration ⇒ no behavior change."
- Skills reference `CLAUDE.process.md` sections by name (per `CLAUDE.md`) — keep section-title wording in sync across files.
- Design-doc approval, feat-req triage, and review findings remain hard stops regardless of the Autonomy Policy — the new steps never gate those.
- A failed `sync-doc.mjs` call must never block the lifecycle step it's attached to from completing locally — catch the error, warn, and continue (the local git file is always the source of truth if the remote call fails; see design doc "Security Considerations").
- Every skill edit ends with a verification step: re-read the file and confirm the new step is present, correctly conditional, and ordered consistently with its neighbors.

## Repositories

Single-repo effort — the kit itself.

| key | role | tier |
|---|---|---|
| `sdlskills` (this repo) | owner | standard |

## Repositories in scope

`sdlskills` — owns every change. No consumers.

---

### Task 1: `setup-sdlc` — doc-store config step

**Files:**
- Modify: `skills/setup-sdlc/SKILL.md`

- [ ] **Step 1: Insert a new "Step 7: Configure the doc store (optional)"** between the current Step 6 (Meta-root wiring) and Step 7 (Autonomy interview), renumbering the old Steps 7–9 to 8–10. Content:
  - Ask: "Should feature requests, design docs, and ADRs also sync to JIRA/Confluence? (default: no — git only)."
  - If no (or the user is unsure) → do nothing; `doc-store.yml` stays absent, `store: git` behavior applies. Say so explicitly and move on.
  - If yes → collect `jira.base_url`, `jira.project_key`, `confluence.base_url`, `confluence.space_key`; write `doc-store.yml` from `doc-store.example.yml` (schema in `docs/design/pluggable-doc-store.md`). Ask which two environment variables hold the adopter's Atlassian account email and API token (default names `JIRA_EMAIL` / `JIRA_API_TOKEN`); confirm they are set in the adopter's shell/CI secrets — the kit never asks for or stores the token value itself.
  - Verify the connection: `node -e "import('./scripts/lib/doc-store.mjs').then(async m=>{const s=m.getDocStore(await import('./scripts/lib/doc-store-config.mjs').then(c=>c.loadDocStoreConfig(process.cwd())));console.log('ok')})"` — or a dedicated `--check` flag if one is added during implementation. Report connection failures and let the adopter fix env vars before continuing; do not block the rest of setup on it.

- [ ] **Step 2: Update the skill's frontmatter `description`** to mention "optionally configures a JIRA/Confluence doc store".

- [ ] **Step 3: Verify** — re-read `skills/setup-sdlc/SKILL.md`; confirm the new step is between meta-root wiring and the autonomy interview, all step numbers below it are shifted, and it correctly defaults to "no" / git-only.

- [ ] **Step 4: Commit** — `git commit -m "feat(setup-sdlc): optional doc-store configuration step"`

---

### Task 2: `write-feature-request` — push the Epic on triage

**Files:**
- Modify: `skills/write-feature-request/SKILL.md`

- [ ] **Step 1: Insert a new "Step 3.5: Push to the doc store (optional)"** between Step 3 (Triage) and Step 4 (Hand off). Content:
  - Only when `doc-store.yml` selects `jira-confluence` and the triage result is `ACCEPTED` (never for `PARKED`/`REJECTED` — no Epic is created for those).
  - Run `node scripts/sync-doc.mjs push docs/feat-req/<name>.md --type epic`. This creates the Epic on first run and writes `jira_key` into the feat-req's frontmatter; re-running (e.g. after a later edit) updates it.
  - On failure (network, auth, conflict), warn the user with the error and continue — the local file (already written and triaged in Steps 2–3) is unaffected.

- [ ] **Step 2: Update Step 4 (Hand off)** to mention: "If pushed to the doc store, the Epic URL is in the command output — share it with the user alongside the spec path."

- [ ] **Step 3: Verify** — re-read; confirm the push step is skipped entirely (not just no-op logged) when `doc-store.yml` is absent, and that it never runs for `PARKED`/`REJECTED`.

- [ ] **Step 4: Commit** — `git commit -m "feat(write-feature-request): push accepted requests as JIRA Epics"`

---

### Task 3: `write-design-doc` — push the Confluence page on approval

**Files:**
- Modify: `skills/write-design-doc/SKILL.md`

- [ ] **Step 1: Update Step 6 (Approval)** — in the "On approval" bullet (which already sets `status: APPROVED` / feat-req `status: DESIGNED` / runs `render-status.mjs`), add: "If `doc-store.yml` selects `jira-confluence`: run `node scripts/sync-doc.mjs push docs/design/<name>.md --type confluence-page`, creating/updating the Confluence page and writing `confluence_page_id` into the design doc's frontmatter. Then, if the feat-req has a `jira_key`, link the new Confluence page from the Epic (a comment or the Epic's description, at the implementer's judgment — the exact linking mechanism is an implementation detail, not a contract other skills read)."
- [ ] **Step 2: Add a note**: on push failure, warn and continue — approval itself (the local frontmatter flip) is never blocked by a doc-store failure.
- [ ] **Step 3: Verify** — re-read; confirm the push happens only after `status: APPROVED` is set locally (never before — a rejected/revised design should never have created a stray Confluence page from an earlier draft push).
- [ ] **Step 4: Commit** — `git commit -m "feat(write-design-doc): push approved designs to Confluence"`

---

### Task 4: `write-execution-plan` — push Stories/Sub-tasks under the Epic

**Files:**
- Modify: `skills/write-execution-plan/SKILL.md`

- [ ] **Step 1: Update Step 4 (Advance state)** — after "Set the feat-req `status: PLANNED`", add: "If `doc-store.yml` selects `jira-confluence` and the feat-req has a `jira_key`: for each `### Task N: <title>` heading in the plan, run `node scripts/sync-doc.mjs push docs/plans/<name>.md --type story` once per task — passing the task's own heading as the pushed title and its checklist steps as the body — creating one JIRA Story (or Sub-task, for a `trivial`-tier repo row in a multi-repo effort) per plan task, parented under the feat-req's Epic. Record the resulting `jira_key` next to each task heading (e.g. `### Task 1: Foo — KIT-12`) so re-running the plan doesn't create duplicates."
- [ ] **Step 2: Add a constraint**: one JIRA issue creation call per *task*, not per plan file — `sync-doc.mjs`'s current CLI shape (Plan 1) pushes one file as one remote object; per-task granularity means the plan-integration code calls the exported `syncPush()` function directly (not the CLI) once per task with a synthesized `filePath`/body, or (simpler, and the implementer's call) a dedicated `--task <N>` flag is added to `sync-doc.mjs` in this task. Either is acceptable; whichever is chosen must be covered by a test before this task is considered done.
- [ ] **Step 3: Verify** — re-read; confirm the per-task push only fires when both the store is configured and the feat-req already has a `jira_key` (i.e. Task 2's Epic push already ran) — warn and skip (don't fail the plan) if the Epic doesn't exist yet.
- [ ] **Step 4: Commit** — `git commit -m "feat(write-execution-plan): push plan tasks as JIRA Stories/Sub-tasks"`

---

### Task 5: `select-next-task` — pull before ranking

**Files:**
- Modify: `skills/select-next-task/SKILL.md`

- [ ] **Step 1: Update Step 1 (Gather the queue)** — add: "For each candidate that has a `jira_key` (i.e. `doc-store.yml` selects `jira-confluence` and it was already pushed), run `node scripts/sync-doc.mjs pull <file> --type epic` before reading its `status` — this folds in any transition or content edit a human made directly in JIRA since the kit last touched the file. A conflict (both sides changed) surfaces to the user immediately, before ranking proceeds; the user resolves it (per Plan 1's `sync-doc.mjs` conflict message) and re-runs `select-next-task`."
- [ ] **Step 2: Add a note**: this is the mechanism behind the design's "status derived from JIRA transitions" behavior — `select-next-task` is the one place in the lifecycle that always runs before a `status`-dependent decision, so it's the natural pull point rather than adding pulls scattered elsewhere.
- [ ] **Step 3: Verify** — re-read; confirm the pull step is skipped for candidates with no `jira_key` (untouched feat-reqs, or any doc when `store: git`) — no behavior change for the default path.
- [ ] **Step 4: Commit** — `git commit -m "feat(select-next-task): pull JIRA status before ranking"`

---

### Task 6: `close-out` — final status push

**Files:**
- Modify: `skills/close-out/SKILL.md`

- [ ] **Step 1: Update Step 6 (Flip state)** — after "Feat-req `status: IMPLEMENTED`" and "Plan `status: IMPLEMENTED`", add: "If `doc-store.yml` selects `jira-confluence` and the feat-req has a `jira_key`: run `node scripts/sync-doc.mjs push docs/feat-req/<name>.md --type epic` to transition the Epic to Done. Warn and continue (don't block close-out) on failure — the local `IMPLEMENTED` flip is authoritative regardless."
- [ ] **Step 2: Verify** — re-read; confirm this push happens after Step 5 (Definition of Done) has passed clean, not before.
- [ ] **Step 3: Commit** — `git commit -m "feat(close-out): transition the JIRA Epic to Done on implementation"`

---

### Task 7: `install-sdlc.mjs` — vendor `doc-store.example.yml`

**Files:**
- Modify: `scripts/install-sdlc.mjs`
- Modify: `scripts/install-sdlc.test.mjs`

**Interfaces:**
- Consumes: nothing new — `scripts/lib/doc-store*.mjs` and `scripts/sync-doc.mjs` (Plan 1) are already vendored automatically, since Step 2 of `install()` copies every entry under `scripts/` recursively.

- [ ] **Step 1: Write the failing test**

Add to `scripts/install-sdlc.test.mjs`:

```js
test('seeds doc-store.example.yml but keeps an existing one', () => {
  const dir = target();
  install(opts(dir));
  assert.ok(existsSync(join(dir, 'doc-store.example.yml')));

  writeFileSync(join(dir, 'doc-store.example.yml'), 'MINE\n');
  install(opts(dir));
  assert.equal(readFileSync(join(dir, 'doc-store.example.yml'), 'utf8'), 'MINE\n');
  rmSync(dir, { recursive: true });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `node --test scripts/install-sdlc.test.mjs`
Expected: FAIL — `doc-store.example.yml` not found in the target.

- [ ] **Step 3: Implement** — in `scripts/install-sdlc.mjs`, add one entry to the seed list (the array containing `['repos.example.yml', 'repos.example.yml']`, install.mjs line ~132):

```js
['doc-store.example.yml', 'doc-store.example.yml'],
```

- [ ] **Step 4: Run — verify pass**

Run: `node --test scripts/install-sdlc.test.mjs`
Expected: all tests pass, including the new one.

- [ ] **Step 5: Commit**

```bash
git add scripts/install-sdlc.mjs scripts/install-sdlc.test.mjs
git commit -m "feat(install-sdlc): seed doc-store.example.yml"
```

---

### Task 8: `CLAUDE.process.md` — prose

**Files:**
- Modify: `CLAUDE.process.md`

- [ ] **Step 1: Add a row to the Artifacts table** (after the `Setup (once) | Repository catalog | ...` row):

```markdown
| Setup (once, optional) | Doc-store config | `doc-store.yml` | `/setup-sdlc` |
```

- [ ] **Step 2: Add a `## Doc store (optional)` section** (after `## Working in the meta-root`, if present, else after the Artifacts table):

```markdown
## Doc store (optional)

By default every artifact lives only in git. An adopter can opt into
syncing feature requests, design docs, and ADRs to JIRA + Confluence via
`doc-store.yml` (`/setup-sdlc` offers this; absent file = git only, no
behavior change). When configured:

- Feature requests become JIRA Epics on triage `ACCEPTED`.
- Design docs and ADRs become Confluence pages on approval.
- Plan tasks become JIRA Stories/Sub-tasks under the Epic.
- `status` is folded in from JIRA transitions by `select-next-task` before
  it ranks the queue — a human moving a ticket in JIRA is respected, not
  fought.
- A conflicting edit (both the local file and the remote changed since the
  last sync) is always surfaced to the user, never silently overwritten.

See `docs/design/pluggable-doc-store.md` and ADR 005.
```

- [ ] **Step 3: Verify** — re-read the whole file; confirm no section-title drift versus the skills that reference these sections (Autonomy Policy, State, Definition of Done, Artifacts).

- [ ] **Step 4: Commit** — `git commit -m "docs(process): pluggable doc store"`

---

### Task 9: `migrate-docs-to-store.mjs` — optional backfill tool

**Files:**
- Create: `scripts/migrate-docs-to-store.mjs`
- Create: `scripts/migrate-docs-to-store.test.mjs`

**Interfaces:**
- Consumes: `loadDocStoreConfig` (Plan 1 Task 1), `getDocStore` (Plan 1 Task 4), `syncPush` (Plan 1 Task 5).
- Produces:
  - `listMigratable(rootDir) -> { filePath: string, artifactType: 'epic'|'confluence-page' }[]` — every `docs/feat-req/*.md` (→ `epic`) and `docs/design/*.md` + `docs/decisions/*.md` (→ `confluence-page`), excluding the living docs `architecture.md` / `data-model.md`. **Plan files are not migrated** — backfilling individual historical plan tasks as JIRA Stories retroactively is out of scope for v1 (see the design doc's Open Items).
  - `migrate({ rootDir, dryRun?, config?, store? }) -> { migrated: {filePath, artifactType, remoteId}[], skipped: {filePath, artifactType, error}[] }` — a true no-op (`migrated: []`) when the store is `git`.
  - CLI: `node scripts/migrate-docs-to-store.mjs [--dry-run] [--root <dir>]` — never run automatically by any skill.

- [ ] **Step 1: Write the failing test**

`scripts/migrate-docs-to-store.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listMigratable, migrate } from './migrate-docs-to-store.mjs';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mig-'));
  mkdirSync(join(dir, 'docs', 'feat-req'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'design'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'decisions'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'feat-req', 'x.md'), '---\nstatus: ACCEPTED\n---\n\n# X\n\nBody.\n');
  writeFileSync(join(dir, 'docs', 'design', 'x.md'), '---\nstatus: APPROVED\n---\n\n# X\n\nBody.\n');
  writeFileSync(join(dir, 'docs', 'design', 'architecture.md'), '# Architecture\n');
  writeFileSync(join(dir, 'docs', 'decisions', '001_x.md'), '# X\n\nBody.\n');
  return dir;
}

function fakeStore() {
  let seq = 0;
  return {
    async push() {
      seq += 1;
      return { remoteId: `KIT-${seq}`, url: `https://example/KIT-${seq}` };
    },
    async pull() {
      return null;
    },
  };
}

test('listMigratable finds feat-req, design, and decisions but skips living design docs', () => {
  const dir = setup();
  const files = listMigratable(dir).map((f) => f.filePath.replace(dir, ''));
  assert.ok(files.some((f) => f.includes('feat-req/x.md')));
  assert.ok(files.some((f) => f.includes('design/x.md')));
  assert.ok(files.some((f) => f.includes('decisions/001_x.md')));
  assert.ok(!files.some((f) => f.includes('architecture.md')));
  rmSync(dir, { recursive: true });
});

test('migrate is a no-op when the store is "git"', async () => {
  const dir = setup();
  const r = await migrate({ rootDir: dir, config: { store: 'git' } });
  assert.deepEqual(r.migrated, []);
  rmSync(dir, { recursive: true });
});

test('migrate pushes every migratable file and records the new remote id', async () => {
  const dir = setup();
  const store = fakeStore();
  const r = await migrate({ rootDir: dir, config: { store: 'jira-confluence' }, store });
  assert.equal(r.migrated.length, 3);
  assert.equal(r.skipped.length, 0);
  rmSync(dir, { recursive: true });
});

test('--dry-run reports what would migrate without pushing', async () => {
  const dir = setup();
  const r = await migrate({ rootDir: dir, config: { store: 'jira-confluence' }, dryRun: true });
  assert.equal(r.migrated.length, 3);
  assert.ok(r.migrated.every((m) => m.dryRun));
  rmSync(dir, { recursive: true });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `node --test scripts/migrate-docs-to-store.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `scripts/migrate-docs-to-store.mjs`**

```js
#!/usr/bin/env node
/**
 * migrate-docs-to-store.mjs — one-time, adopter-invoked backfill of existing
 * git-committed docs into the configured JIRA/Confluence doc store. Never
 * run automatically (see docs/design/pluggable-doc-store.md → "Rollout &
 * Migration"). Migrates docs/feat-req/*.md (→ Epics) and docs/design/*.md +
 * docs/decisions/*.md (→ Confluence pages). Plan files are not migrated —
 * backfilling individual historical plan tasks as JIRA Stories/Sub-tasks
 * retroactively is out of scope for v1 (see the design doc's Open Items).
 *
 * Usage: node scripts/migrate-docs-to-store.mjs [--dry-run] [--root <dir>]
 */
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadDocStoreConfig } from './lib/doc-store-config.mjs';
import { getDocStore } from './lib/doc-store.mjs';
import { syncPush } from './sync-doc.mjs';

const TARGETS = [
  { dir: 'feat-req', artifactType: 'epic' },
  { dir: 'design', artifactType: 'confluence-page' },
  { dir: 'decisions', artifactType: 'confluence-page' },
];

const LIVING_DOCS = ['architecture.md', 'data-model.md'];

export function listMigratable(rootDir) {
  const files = [];
  for (const { dir, artifactType } of TARGETS) {
    const full = join(rootDir, 'docs', dir);
    if (!existsSync(full)) continue;
    for (const f of readdirSync(full)) {
      if (!f.endsWith('.md') || LIVING_DOCS.includes(f)) continue;
      files.push({ filePath: join(full, f), artifactType });
    }
  }
  return files;
}

export async function migrate({ rootDir, dryRun = false, config, store }) {
  const cfg = config ?? loadDocStoreConfig(rootDir);
  if (cfg.store === 'git') {
    return { migrated: [], skipped: [], reason: 'store is "git" — nothing to migrate' };
  }
  const docStore = store ?? getDocStore(cfg);
  const files = listMigratable(rootDir);
  const migrated = [];
  const skipped = [];
  for (const { filePath, artifactType } of files) {
    if (dryRun) {
      migrated.push({ filePath, artifactType, remoteId: null, dryRun: true });
      continue;
    }
    try {
      const result = await syncPush({ rootDir, filePath, artifactType, config: cfg, store: docStore });
      migrated.push({ filePath, artifactType, remoteId: result.remoteId });
    } catch (err) {
      skipped.push({ filePath, artifactType, error: err.message });
    }
  }
  return { migrated, skipped };
}

function main() {
  const args = process.argv.slice(2);
  const rootIx = args.indexOf('--root');
  const rootDir = rootIx !== -1 ? args[rootIx + 1] : process.cwd();
  const dryRun = args.includes('--dry-run');
  migrate({ rootDir, dryRun })
    .then((r) => {
      console.log(`migrate-docs-to-store: migrated ${r.migrated.length}, skipped ${r.skipped.length}${dryRun ? ' (dry run)' : ''}`);
      r.skipped.forEach((s) => console.error(`  skipped ${s.filePath}: ${s.error}`));
    })
    .catch((err) => {
      console.error(`migrate-docs-to-store: ${err.message}`);
      process.exit(1);
    });
}

if (import.meta.url === `file://${process.argv[1]}`) main();
```

- [ ] **Step 4: Run — verify pass**

Run: `node --test scripts/migrate-docs-to-store.test.mjs`
Expected: 4 tests pass.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: every test from both plans passes.

- [ ] **Step 6: Commit**

```bash
git add scripts/migrate-docs-to-store.mjs scripts/migrate-docs-to-store.test.mjs
git commit -m "feat: optional one-time migration of existing docs to the doc store"
```

---

## Pull Requests

N/A — single-repo effort (`sdlskills`), executed on `main` per this repo's own convention. Fill a `key | branch | PR | state` table here if this repo later adopts a PR workflow for its own changes.

## Self-Review

- **Spec coverage** (design §6 skill-integration table + §7 migration): `setup-sdlc` ✓ T1; `write-feature-request` ✓ T2; `write-design-doc` ✓ T3; `write-execution-plan` ✓ T4; `select-next-task` ✓ T5; `close-out` ✓ T6; `install-sdlc.mjs` vendoring ✓ T7 (scripts themselves vendor automatically via the existing recursive copy — only the example config needed a seed-list entry); `CLAUDE.process.md` ✓ T8; migration tool ✓ T9.
- **Placeholders:** T2/T3/T5/T6 specify exact inserted prose (acceptable for skill-file edits, matching the execution-environment Plan 2 precedent); T4 (per-task push granularity) deliberately leaves an implementation choice open — flagged explicitly as "either is acceptable, must be tested" rather than hidden as a TODO. T7 and T9 have full inline code.
- **Type consistency:** `syncPush`/`getDocStore`/`loadDocStoreConfig` signatures (T9) match Plan 1 Task 5/4/1 exactly, unchanged. `listMigratable`/`migrate` shapes match their tests.
- **Failure isolation:** every skill task (T2, T3, T4, T6) explicitly states that a doc-store failure warns and continues rather than blocking the local lifecycle step — carried through from the design's "Security Considerations" (fail closed on the remote write, never on the local one).

## Execution

REQUIRED SUB-SKILL: `superpowers:executing-plans`. T1–T6 and T8 touch independent files and can run in any order; T7 and T9 depend on Plan 1 (specifically `sync-doc.mjs`, `doc-store-config.mjs`, `doc-store.mjs`) being merged. T4 depends on T2 (needs the Epic's `jira_key` to parent Stories under).

## Open Items (carried from the design)

- [ ] Exact JIRA issue-type / transition names against a real target project — confirm during implementation against a sandbox project before this effort's close-out.
- [ ] Per-task push granularity for `write-execution-plan` (T4) — CLI flag vs. calling `syncPush` directly — decide and document during implementation.
- [ ] Whether `/setup-sdlc`'s doc-store step should be asked of every adopter or only offered when they mention JIRA/Confluence — currently: always asked, defaults to no.
