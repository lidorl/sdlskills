---
feat_req: docs/feat-req/execution-environment.md
design: docs/design/execution-environment.md
status: PLANNED
date: 2026-09-09
plan: 2 of 2
---

# Multi-repo execution environment — Plan 2: Lifecycle integration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Plan 1 foundation (catalog + scripts) into every phase of the lifecycle, so a cross-repo effort flows request → design → plan → development → review → close-out coherently.

**Architecture:** Mostly edits to the phase skills under `skills/` and to `CLAUDE.process.md`, plus a tested change to `render-status.mjs`. Each skill gains the multi-repo steps described in the design's per-skill table.

**Tech Stack:** Markdown (skill files), Node (`render-status.mjs`), `gh` CLI (referenced by `close-out`).

**Spec:** `docs/design/execution-environment.md` — see the "Per-skill changes", "CLAUDE.process.md changes", and "render-status.mjs changes" sections. Requires Plan 1 merged.

## Global Constraints

- Skills reference `CLAUDE.process.md` sections by name — keep the wording of section titles in sync across files.
- Path references everywhere: `<key>:<repo-relative-path>`; bare path = meta-root.
- `hotfix` is effort-level, never a per-repo tier.
- Design-doc approval, feat-req triage, and review findings remain hard stops regardless of the Autonomy Policy.
- Every skill edit ends with a verification step: re-read the file and confirm the new section is present, ordered correctly, and consistent with `CLAUDE.process.md`.

## Repositories

Single-repo effort — the kit itself.

| key | role | tier |
|---|---|---|
| `sdlskills` (this repo) | owner | standard |

## Repositories in scope

`sdlskills` — owns every change. No consumers.

---

### Task 1: `setup-sdlc` — catalog interview + meta-root wiring

**Files:**
- Modify: `skills/setup-sdlc/SKILL.md`

- [ ] **Step 1: Add a "Build the repository catalog" step** after the repo-mapping / before the autonomy interview. Content:
  - Ask the user to list every repo the project works across. For each: `key` (short handle), `url`, `default_branch`, `domain`, a `summary` paragraph, `responsibilities` (bullets), `depends_on` (other keys), `keywords`.
  - **N=1 shortcut:** if the user names one repo, fetch its README and draft the single entry; one confirmation.
  - Write `repos.yml` (schema in `docs/design/execution-environment.md` / `repos.example.yml`). For any repo the user wants to elaborate, create `repos/<key>.md` from the template in `repos/README.md` and set `notes: true`.
  - Run `node -e "import('./scripts/lib/catalog.mjs').then(m=>m.loadCatalog(process.cwd()))"` (or a dedicated `--check` flag if added) to validate; fix reported problems before continuing.

- [ ] **Step 2: Add a "Meta-root wiring" step**:
  - Ensure `package.json` exists with `yaml` (Plan 1 Task 1) and run `npm install`.
  - Ensure `.gitignore` contains `workspace/` and `node_modules/`.
  - Confirm `scripts/assemble-env.mjs` and `scripts/clean-env.mjs` are present (they ship with the kit).

- [ ] **Step 3: Update the skill's frontmatter `description`** to mention "builds the repository catalog".

- [ ] **Step 4: Verify** — re-read `skills/setup-sdlc/SKILL.md`; confirm the catalog step precedes the autonomy interview and references `repos.yml` / `repos.example.yml` correctly.

- [ ] **Step 5: Commit** — `git commit -m "feat(setup-sdlc): build the repository catalog"`

---

### Task 2: `write-design-doc` — repo selection + binding

**Files:**
- Modify: `skills/write-design-doc/SKILL.md`

- [ ] **Step 1: Insert a new "Step 2.5: Resolve the repository set"** between Step 2 (understand the current system) and Step 3 (technical brainstorm). Content:
  - Read `repos.yml`. For each repo compare the effort against `summary` + `responsibilities` + `keywords`: clear yes → in scope; clear no → out; ambiguous → read `repos/<key>.md` (if `notes: true`) and re-judge; still ambiguous → ask the user.
  - Pull in `depends_on` repos of any in-scope repo as candidate consumers; judge the same way.
  - Run `node scripts/assemble-env.mjs <name> <key> <key> ...` to check out the provisional set into `workspace/` so code can be read.
  - Note: the set is provisional and may change while designing; re-run `assemble-env.mjs` as it does.

- [ ] **Step 2: Add `repos:` to the frontmatter template** in Step 4 (`repos: [key, key]`).

- [ ] **Step 3: Add a new required section** to the Step 4 template, after `## API Surface Changes`:

```markdown
## Repositories in Scope
Per repo in `repos:`: its key, whether it **owns** the change or is an **affected consumer**, what changes in it, and the integration contract with the other repos. `N/A` only for a genuine single-repo effort.
```

- [ ] **Step 4: Update Step 6 (approval)** to add: "Lock the `repos:` list — it is fixed at approval. Later phases read only this list." And add to the "on approval" actions: nothing extra (feat-req → DESIGNED already there).

- [ ] **Step 5: Add a constraint**: "A repo discovered after approval → add it to `repos:` and `## Repositories in Scope` with a dated note, re-run `/classify-change` for it, get a lightweight re-approval. Not a full redo."

- [ ] **Step 6: Verify** — re-read; confirm section order (`Context → Proposed Design → Data Model → API Surface → Repositories in Scope → UI/UX → Alternatives → Testing → Rollout → Security → Open Items`) and that `render-status.mjs`'s design-doc handling still works (it only reads frontmatter `status`).

- [ ] **Step 7: Commit** — `git commit -m "feat(write-design-doc): repository selection and binding"`

---

### Task 3: `classify-change` — per-repo verdicts

**Files:**
- Modify: `skills/classify-change/SKILL.md`

- [ ] **Step 1: Add a "Multi-repo" subsection**: run Steps 1–3 **once per repo** in the approved design doc's `repos:` list. Output one verdict per repo (`api: standard`, `web: trivial`). The **effort tier** is the highest across repos. `hotfix` is decided once for the whole effort (Step 1), never per repo.

- [ ] **Step 2: Update the output format** in Step 4 to a per-repo table: `key │ tier │ rule │ justification`.

- [ ] **Step 3: Update Step 4's routing** — "standard" (any repo) → the effort enters/continues the standard pipeline; a repo that is `trivial` still gets its plan items + tests + PR but no separate design work (it's already covered by the effort's one design doc).

- [ ] **Step 4: Verify** — re-read; confirm the per-repo loop doesn't contradict the effort-level `hotfix` carve-out.

- [ ] **Step 5: Commit** — `git commit -m "feat(classify-change): per-repo tier verdicts"`

---

### Task 4: `write-execution-plan` — Repositories + Pull Requests sections

**Files:**
- Modify: `skills/write-execution-plan/SKILL.md`

- [ ] **Step 1: Add to Step 2** (write the plan): the plan must include, near the top, a `## Repositories` section — per repo: `key`, role (`owner`|`consumer`), tier (from `classify-change`), one line on what changes. And at the bottom, a `## Pull Requests` section:

```markdown
## Pull Requests
| key | branch | PR | state |
|---|---|---|---|
| api | feat/<slug> | — | not started |
```

- [ ] **Step 2: Add to Step 2**: file references in task `Files:` blocks use `<key>:<path>`.

- [ ] **Step 3: Add to Step 3 (stamp frontmatter)**: also copy `repos:` from the design doc into the plan frontmatter.

- [ ] **Step 4: Add a constraint**: "Merge order lives in the design doc's Rollout & Migration section under a `### Merge order` subheading (ordered list of repo keys + one-line reason). Do not duplicate it in the plan."

- [ ] **Step 5: Verify** — re-read; confirm `## Repositories` and `## Pull Requests` are named exactly (parsed by `render-status.mjs` in Task 9).

- [ ] **Step 6: Commit** — `git commit -m "feat(write-execution-plan): per-repo sections and PR tracking"`

---

### Task 5: Development wiring + `write-history-entry`

**Files:**
- Modify: `skills/write-execution-plan/SKILL.md` (Step 4 handoff)
- Modify: `skills/write-history-entry/SKILL.md`
- Modify: `CLAUDE.process.md` (Development phase note)

- [ ] **Step 1: In `write-execution-plan` Step 4**, add: "Development begins by running `node scripts/assemble-env.mjs <slug>` — this creates `feat/<slug>` across every effort repo. The agent works per the plan; opens one PR per repo when that repo's plan items pass and its tests are green; records each in the plan's `## Pull Requests` table."

- [ ] **Step 2: In `write-history-entry`**, add a `## Per-Repo Summary` section to the standard-tier template:

```markdown
## Per-Repo Summary
| key | tier | branch | PR | what changed |
|---|---|---|---|---|
```

Keep the single narrative for Deviations / Discoveries / Decisions / Verification. `## Incident` stays hotfix-only.

- [ ] **Step 3: In `CLAUDE.process.md`**, add a `## Working in the meta-root` section (see Task 8) — placeholder note here, full text in Task 8.

- [ ] **Step 4: Verify** — re-read both skills; confirm the history template still leads with frontmatter + `#` title (so `render-status.mjs` title extraction is unaffected).

- [ ] **Step 5: Commit** — `git commit -m "feat: multi-repo development wiring + per-repo history summary"`

---

### Task 6: `select-next-task` — assemble on resume

**Files:**
- Modify: `skills/select-next-task/SKILL.md`

- [ ] **Step 1: Add a step** after a task is selected and before routing to its phase: "If the selection is `DESIGNED`/`PLANNED`/`IN_PROGRESS` and has a design doc with a `repos:` list, run `node scripts/assemble-env.mjs <slug>` to reconstruct `workspace/`. Report any mismatch warning to the user."

- [ ] **Step 2: Add**: when reporting an `IN_PROGRESS` effort's state, read the plan's `## Pull Requests` table and summarise (`api merged, web open, shared-types not started`).

- [ ] **Step 3: Verify** — re-read; confirm it doesn't assemble for `ACCEPTED` items (no design doc yet).

- [ ] **Step 4: Commit** — `git commit -m "feat(select-next-task): assemble workspace on resume"`

---

### Task 7: `close-out` — merge order + live PR verification

**Files:**
- Modify: `skills/close-out/SKILL.md`
- Modify: `CLAUDE.process.md` (Definition of Done)

- [ ] **Step 1: Add a step** to the `close-out` checklist, before the status flip: "For each repo in the plan's `## Repositories`: run `gh pr view <pr-url> --json state,mergedAt` and confirm `MERGED`. Verify merge order matches the design doc's `### Merge order`. If any PR is not merged, stop — the effort is not done; report which repos are outstanding."

- [ ] **Step 2: Add** as the skill's final printed line: `run: node scripts/clean-env.mjs` (manual workspace cleanup — not automatic).

- [ ] **Step 3: In `CLAUDE.process.md` Definition of Done**, add: "- [ ] A merged PR in every repo listed in the plan's `## Repositories`; links in `## Pull Requests`; merge order per the design doc's `### Merge order` (verified live via `gh`)."

- [ ] **Step 4: Verify** — re-read; confirm the PR check precedes the `status: IMPLEMENTED` flip.

- [ ] **Step 5: Commit** — `git commit -m "feat(close-out): live cross-repo PR verification"`

---

### Task 8: `CLAUDE.process.md` — prose

**Files:**
- Modify: `CLAUDE.process.md`

- [ ] **Step 1: Add `## Working in the meta-root`** (after the Lifecycle section):

```markdown
## Working in the meta-root

Your project is a **meta-root** git repo: this process contract, the skills,
`repos.yml`, and the `docs/` trail. Code repos are checked out under
`workspace/<key>/` (git-ignored), assembled per effort by
`scripts/assemble-env.mjs`.

- Open your editor on `workspace/<key>/` for hands-on code work.
- The agent `cd`s into `workspace/<key>/` for every stack command (build,
  test, git, `gh`). Never run bare `git`/test/build at the meta-root.
- File references in artifacts use `<key>:<repo-relative-path>`; a bare path
  means the meta-root.
- A solo project is N=1: one `repos.yml` entry, one repo under `workspace/`.
```

- [ ] **Step 2: Add `repos.yml` and `repos/<key>.md`** to the Artifacts table.

- [ ] **Step 3: Add a note to the State table**: "`select-next-task` runs `assemble-env.mjs` before routing a `DESIGNED`+ effort."

- [ ] **Step 4: Update the `## Setup` line** to mention the catalog: "…maps the repo, **builds the repository catalog**, records the autonomy policy…".

- [ ] **Step 5: Verify** — re-read the whole file; confirm no section-title drift vs. the skills that reference it (Autonomy Policy, State, Definition of Done).

- [ ] **Step 6: Commit** — `git commit -m "docs(process): meta-root model, catalog, DoD"`

---

### Task 9: `render-status.mjs` — PR progress + template-count fix

**Files:**
- Modify: `scripts/render-status.mjs`
- Modify: `scripts/render-status.test.mjs` (create if absent)

**Interfaces:**
- Produces: `plan_pr_progress` field on each row — `"2/3 merged"` or `null` when no `## Pull Requests` table.

- [ ] **Step 1: Write the failing test** (`scripts/render-status.test.mjs`):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePullRequests } from './render-status.mjs';

test('parsePullRequests counts merged rows', () => {
  const md = `## Pull Requests
| key | branch | PR | state |
|---|---|---|---|
| api | feat/x | http://p/1 | merged |
| web | feat/x | http://p/2 | open |
| lib | feat/x | — | not started |

## Next section
`;
  assert.deepEqual(parsePullRequests(md), { merged: 1, total: 3 });
});

test('parsePullRequests returns null when the section is absent', () => {
  assert.equal(parsePullRequests('# plan\nno table here'), null);
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `node --test scripts/render-status.test.mjs`
Expected: FAIL — `parsePullRequests` not exported.

- [ ] **Step 3: Implement** — add and export `parsePullRequests(text)` in `render-status.mjs`: locate `## Pull Requests`, read table rows until the next blank line or heading, count rows whose last cell is `merged` (case-insensitive) vs. total data rows. Wire it into the row build (`plan_pr_progress`) and show it in the `table()` output for the Active sections (e.g. a `PRs` column, or append `— 2/3 PRs` to the plan cell).

- [ ] **Step 4: Fix the design-doc count** — line ~55 filter: also exclude names ending `.template` (`d.name !== 'architecture' && d.name !== 'data-model' && !d.name.startsWith('STYLE_GUIDE')`).

- [ ] **Step 5: Run — verify pass**

Run: `node --test scripts/render-status.test.mjs && node scripts/render-status.mjs`
Expected: tests pass; `STATUS.md` shows the correct design-doc count and (once a plan with a PR table exists) PR progress.

- [ ] **Step 6: Commit** — `git commit -m "feat(render-status): cross-repo PR progress; fix template count"`

---

### Task 10: Landing page + README

**Files:**
- Modify: `site/index.html`
- Modify: `README.md`

- [ ] **Step 1: Add a short "Multi-repo by default" block** to `site/index.html` — one section explaining the meta-root + `workspace/` + catalog model, in the existing drafting-set visual system (no new tokens, no new fonts). Link the concept to the 2-repo example (BRAINSTORMING.md §3) as "walkthrough coming".

- [ ] **Step 2: Update `README.md`** — the "How it works" / lifecycle prose gains a sentence on multi-repo; the mermaid diagram gets a note that Design resolves the repo set and Development assembles `workspace/`.

- [ ] **Step 3: Verify** — open `site/index.html` in a browser (or screenshot) once; confirm the new block matches the page's type scale and both themes.

- [ ] **Step 4: Commit** — `git commit -m "docs: multi-repo on the landing page and README"`

---

## Self-Review

- **Spec coverage** (design "Per-skill changes" table): `setup-sdlc` ✓ T1; `write-design-doc` ✓ T2; `classify-change` ✓ T3; `write-execution-plan` ✓ T4; Development + `write-history-entry` ✓ T5; `select-next-task` ✓ T6; `close-out` ✓ T7; `gather-open-items` key-prefix — **folded into T2/T4 path-convention notes**, flag if it needs its own task on execution; `CLAUDE.process.md` ✓ T8; `render-status.mjs` ✓ T9; landing page ✓ T10.
- **`architecture.md`:** created in T8's neighbourhood? — No. The design's Rollout step 8 says architecture.md is created during implementation; add it as a step in T8 if the executor judges the meta-root model warrants a standalone `docs/design/architecture.md` for the kit. Currently the kit has none; recommend creating a minimal one here.
- **Placeholders:** T3/T5/T6/T7/T8 specify the *content* of each edit but not verbatim final wording for every skill line — acceptable for prose edits; the code task (T9) has full inline code.
- **Type consistency:** `## Repositories` / `## Pull Requests` section names identical across T4, T5, T7, T9. `parsePullRequests` return shape `{merged, total}` matches its test.

## Execution

REQUIRED SUB-SKILL: `superpowers:executing-plans`. Tasks are mostly independent; T5 and T7 both touch `CLAUDE.process.md` (T8 owns the big prose block — do T8 last or coordinate). T9 depends on nothing here but needs Plan 1 merged.

## Open Items (carried from the design)

- [ ] `gather-open-items` may need an explicit task for the `<key>:` path prefix in extracted items — verify during execution.
- [ ] Minimal `docs/design/architecture.md` for the kit — decide during T8.
- [ ] Existing single-repo adopter migration (`setup-sdlc --migrate`) — separate feature request.
