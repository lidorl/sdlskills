---
feat_req: docs/feat-req/feature-request-breakdown.md
design: docs/design/feature-request-breakdown.md
status: IN_PROGRESS
date: 2026-11-24
repos: [sdlskills]
---

# Breakdown at the feature request phase: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every new feature request gets a recorded size check. A large request with independent parts is split into slices at triage. Slices carry `split_from` and `after`, and no slice is ranked or claimed before its `after` items are `IMPLEMENTED`. STATUS.md shows progress for each split.

**Architecture:** One pure helper, `unmetAfter()` in `queue.mjs`, decides whether an effort is blocked. `rank()`, the claim write and `render-status.mjs` all call it, so the three can't disagree. The sizing check, slicing and re-check mode are skill text in `write-feature-request`, configured by a `breakdown:` block in `CLAUDE.process.md`.

**Tech Stack:** Node ≥20 (`node:test`, `node:assert/strict`), the existing `yaml` dependency, Markdown skills.

**Spec:** `docs/design/feature-request-breakdown.md` (APPROVED), implementing `docs/feat-req/feature-request-breakdown.md`.

## Global Constraints

- No new runtime dependency.
- A feat-req with no `after` and no `split_from` behaves exactly as today everywhere. Without any `split_from` in `docs/feat-req/`, `docs/STATUS.md` and `docs/.status.json` are identical to today's output for the same docs, except that `.status.json` feature rows gain `split_from: null, after: []`.
- `after` entries must match `SLUG_RE` from `scripts/lib/board/safe-path.mjs`. An invalid or unknown entry counts as not done (it blocks), and `sdlc check` reports it.
- An effort counts as done for `after` only when its status is exactly `IMPLEMENTED`.
- Default thresholds, verbatim: `max_criteria: 12`, `max_personas: 3`, `max_repos: 2`, `max_files: 30`, `min_slice_criteria: 3`.
- Split rule, verbatim: propose a split when at least one size signal exceeds its threshold **and** there are at least two independent parts.
- The user override in `select-next-task` does not bypass `after`.
- Skill and `CLAUDE.*.md` edits use `mattpocock-skills:writing-for-agents`. Skills reference `CLAUDE.process.md` sections by name.
- The Copilot flavor comes from the `REWRITES` table in `scripts/install-sdlc-copilot.mjs`. `npm test` must pass.
- `sdlc claim` has no `--json` flag today, and this plan doesn't add one. The design's mention of `--json` fields on claim is dropped, and the refusal is reported in the stderr message only.

## Review Focus

- **`after` written as a scalar** (`after: board-claims`, not a list). Expect it to be treated as a one-item list, not ignored. Pinned in Task 1.
- **An `after` cycle** (A after B, B after A, or A after itself). Expect both to be blocked, and `sdlc check` to report the cycle by name. Pinned in Task 1.
- **`after` naming a PARKED or REJECTED effort.** Expect the slice to stay blocked, and STATUS.md to name the blocker with its status so a person can fix the list. Pinned in Task 3.
- **An empty list (`after: []`).** Expect it to be treated as no ordering, not as blocked. Pinned in Task 1.
- **The `after` effort becomes `IMPLEMENTED` on origin/main after the local clone ranked it as blocked.** Expect a direct `sdlc claim` to succeed, because the claim reads origin/main, not the stale local tree. Pinned in Task 2.

## Repositories

- `sdlskills`: owner, tier `standard` (carve-out: API surface, the new `sdlc claim` refusal). It gets every change: `scripts/lib/board/`, `scripts/render-status.mjs`, `CLAUDE.process.md`, the two skills, and the README.

---

### Task 1: `unmetAfter`, ranking and `sdlc check`

**Files:**
- Modify: `scripts/lib/board/queue.mjs` (`loadEfforts`, `rank`, a new export)
- Test: `scripts/lib/board/queue.test.mjs`

**Interfaces:**
- Produces: `export function afterList(fm: object) -> string[]`, which normalizes `fm.after` (missing or null → `[]`, scalar → `[String(x)]`, array → items as strings).
- Produces: `export function unmetAfter(fm: object, statusOf: (slug: string) => string | null) -> string[]`, which returns the `afterList(fm)` entries whose status isn't exactly `IMPLEMENTED`. Invalid slugs and unknown slugs (`statusOf` returns `null`) are included.
- `rank(efforts, opts)` keeps its signature and also drops efforts with a non-empty `unmetAfter`.
- `loadEfforts(root)` keeps its signature, and its `problems` gain `after` problems.

- [x] **Step 1: Write the failing tests** in `queue.test.mjs`:
  - `test('rank drops an effort whose after is not IMPLEMENTED, keeps it once it is')`: `e('b', { fm: { after: ['a'] } })` with `e('a', { status: 'IN_PROGRESS' })` → `slugs(rank(...))` excludes `'b'`. With `a` at `status: 'IMPLEMENTED'` (passed in the list, though not a candidate) → it includes `'b'`.
  - `test('unknown or invalid after entries block')`: `after: ['ghost']` and `after: ['Bad Slug']` → both excluded.
  - `test('scalar after is a one-item list; empty list is no ordering')`: `after: 'a'` with `a` IN_PROGRESS → excluded; `after: []` → included.
  - `test('two slices with no after link both rank')`: two efforts with `split_from: 'x'` and no `after` → both present.
  - `test('unmetAfter returns the unmet slugs in order')`: `assert.deepEqual(unmetAfter({ after: ['a','b','c'] }, s => ({a:'IMPLEMENTED', b:'PARKED'})[s] ?? null), ['b','c'])`.
  - `test('loadEfforts reports invalid, unknown and cyclic after entries')`: on a temp docs tree with feat-reqs `x` (`after: [y]`), `y` (`after: [x]`), `z` (`after: [ghost, "Bad Slug"]`), `problems` contains messages matching `/after: "ghost" is not a feature request/`, `/after: "Bad Slug" is not a valid slug/` and `/after cycle: x -> y -> x/`. The cycle is reported once.
- [x] **Step 2: Run them and see them fail.** Run `node --import ./scripts/test-setup.mjs --test scripts/lib/board/queue.test.mjs`. Expected: the new tests fail (`unmetAfter is not a function`, or wrong rank output).
- [x] **Step 3: Implement** `afterList` and `unmetAfter` in `queue.mjs`. In `rank`, build `const statusOf = new Map(efforts.map(e => [e.slug, e.status]))` once, and filter with `unmetAfter(e.fm, s => statusOf.get(s) ?? null).length === 0`. In `loadEfforts`, after the loop, add problems for `after` entries that are invalid or unknown, and run a DFS over the `after` graph that reports each cycle once as `after cycle: a -> b -> a`, with the file set to the first feat-req in the cycle.
- [x] **Step 4: Run the file again and see it pass.** Expected: all `queue.test.mjs` tests pass, including the existing ones.
- [x] **Step 5: Commit.** `git commit -m "feat(board): after blocks ranking; sdlc check reports bad after entries"`

### Task 2: The claim refuses while `after` is unmet

**Files:**
- Modify: `scripts/lib/board/claims.mjs` (`claim()` mutate)
- Modify: `scripts/lib/board/cli.mjs` (`cmdClaim` message map)
- Test: `scripts/lib/board/claims.test.mjs`, `scripts/lib/board/cli.test.mjs`

**Interfaces:**
- Consumes: `unmetAfter(fm, statusOf)` from Task 1.
- Produces: `claim()` returns `{ ok: false, reason: 'blocked', waitingOn: string[] }` when the mutate sees unmet `after` items. The order of checks in mutate is `gone`, `closed`, `awaiting`, `blocked`, then the existing live and stale checks.
- Produces: `sdlc claim` exits 1, and its stderr reads `blocked: <slug> waits on <dep> (<STATUS or "missing">)[, <dep> (...)]`.

- [x] **Step 1: Write the failing tests.**
  - `claims.test.mjs`, `test('claim refuses blocked while after is unmet; succeeds once the after effort is IMPLEMENTED on origin/main')`: `makeBoard({ featReqs: { a: { status: 'IN_PROGRESS' }, b: { status: 'ACCEPTED', after: ['a'] } } })`.
    - Claiming `b` gives `{ ok: false, reason: 'blocked', waitingOn: ['a'] }`.
    - Then a second clone sets `a` to `IMPLEMENTED` and pushes. Without fetching in the first clone, `claim(b)` gives `ok: true`. This pins the Review Focus "stale local clone" item.
  - `claims.test.mjs`, `test('two slices with no after link are claimed by two workers')`: `c1` and `c2` with `split_from: x`, claimed from clones `a` and `b` → both `ok: true`.
  - `cli.test.mjs`, `test('claim of a blocked slice exits 1 naming what it waits on')`: `b` after `[a, ghost]` with `a` ACCEPTED → `r.code === 1`, and `r.err` matches `/blocked: b waits on a \(ACCEPTED\), ghost \(missing\)/`.
  - `cli.test.mjs`, `test('next skips a blocked slice')`: with `b` after `[a]` and `a` ACCEPTED, `sdlc next --json` returns `next.slug === 'a'`, and `b` is never returned.
- [x] **Step 2: Run them and see them fail.** Run `node --import ./scripts/test-setup.mjs --test scripts/lib/board/claims.test.mjs scripts/lib/board/cli.test.mjs`. Expected: the new tests fail (the claim succeeds, or the message doesn't match).
- [x] **Step 3: Implement.** In the `claim()` mutate, compute `unmetAfter(cur.fm, s => readFm(tree, s)?.fm.status ?? null)`. Guard each slug with `SLUG_RE` before `featReqPath`, since an invalid one counts as missing. When the list is non-empty, set `refusal = 'blocked'`, keep the list, and return it as `waitingOn`. In `cmdClaim`, add the `blocked` message, reading each dependency's status from origin/main with `committedFm(root, dep, 'origin/main')?.status ?? 'missing'`.
- [x] **Step 4: Run both files again and see them pass.**
- [x] **Step 5: Commit.** `git commit -m "feat(board): claim refuses blocked while after items are unmet"`

### Task 3: STATUS.md Splits section

**Files:**
- Modify: `scripts/render-status.mjs` (`parseFrontmatter`, `renderStatus`)
- Test: `scripts/render-status.test.mjs`

**Interfaces:**
- Consumes: `afterList`, `unmetAfter` from Task 1 (import from `./lib/board/queue.mjs`).
- Produces: `parseFrontmatter` returns an array for a flow-list value (`[a, b]` → `['a','b']`, `[]` → `[]`, with surrounding quotes stripped per item).
- Produces: `.status.json` feature rows gain `split_from: string | null` and `after: string[]`.

- [x] **Step 1: Write the failing tests** in `render-status.test.mjs`:
  - `test('Splits section groups slices with progress and blockers')`: feat-reqs `w-reg` (IMPLEMENTED, `split_from: w`), `w-claims` (IN_PROGRESS, `split_from: w`, `after: [w-reg]`), `w-req` (ACCEPTED, `split_from: w`, `after: [w-claims]`). `md` contains `## Splits`, `### w — 1 of 3 implemented`, and the row `| w-req | ACCEPTED | w-claims | w-claims (IN_PROGRESS) |`. In the Accepted table, the `w-req` status cell reads `ACCEPTED (blocked)`.
  - `test('a slice after a PARKED effort shows the blocker with its status')`: `s` (`split_from: g`, `after: [p]`) with `p` PARKED → the row shows `p (PARKED)`.
  - `test('no split_from anywhere: no Splits section, output unchanged')`: the existing fixture docs → `md` doesn't contain `## Splits`, and each `json.features` row has `split_from === null` and `after` deep-equal to `[]`.
  - `test('parseFrontmatter reads flow lists')`: export `parseFrontmatter` for the test. `after: [a, "b"]` → `['a','b']`; `after: []` → `[]`.
- [x] **Step 2: Run the file and see the new tests fail.** Run `node --import ./scripts/test-setup.mjs --test scripts/render-status.test.mjs`.
- [x] **Step 3: Implement.**
  - Extend `parseFrontmatter` for flow lists.
  - Add `split_from` and `after` to each row.
  - Compute `blockedBy` per row with `unmetAfter` over a status map of all feat-reqs.
  - Render `## Splits` after the Active section only when any row has `split_from`. Use one `### <split_from> — <n> of <m> implemented` block per group, sorted by group name, with the table `| Slice | Status | After | Blocked by |` and slices sorted by slug. A missing blocker shows as `missing`.
  - Append ` (blocked)` to the Status cell of blocked rows in the existing tables.
- [x] **Step 4: Run the file again and see it pass.** Also run `node scripts/render-status.mjs` in the repo root. Expected: it prints `render-status:` with no error, and `docs/STATUS.md` has a `## Splits` section with one block, `### feature-breakdown — 0 of 2 implemented`, listing `feature-request-breakdown` and `plan-breakdown`. This repo's own split.
- [x] **Step 5: Commit.** `git commit -m "feat(status): Splits section and blocked marker"`

### Task 4: Process contract and README

**Files:**
- Modify: `CLAUDE.process.md` (Autonomy Policy area, State, Workers and the board)
- Modify: `README.md` (upgrade notes)

**Interfaces:**
- Produces: a `breakdown:` YAML block, which the Task 5 skill text cites by the section name **Breakdown**.

- [x] **Step 1: Add a `### Breakdown` subsection** under `## Autonomy Policy`, after the autonomy block, with this exact block and one sentence saying that the size check always runs and these values only tune it:
  ```yaml
  breakdown:
    feature_request:
      max_criteria: 12
      max_personas: 3
      max_repos: 2
      max_files: 30
      min_slice_criteria: 3
  ```
- [x] **Step 2: Document the new fields in `## State`.** Add a short table for every mode, not only board mode: `split_from` (the original idea's slug; a label, never a file) and `after` (slugs that must be `IMPLEMENTED` before this effort is ranked or claimed; editing it is the only override).
- [x] **Step 3: Add the claim rule to "Workers and the board".** Add one bullet: a claim is refused (`blocked`) while any `after` item isn't `IMPLEMENTED`.
- [x] **Step 4: Add a README upgrade note.** Re-running the installer replaces `CLAUDE.process.md`, so tuned `breakdown:` values must be re-applied.
- [x] **Step 5: Run `npm test`.** Expected: all pass, including `install-sdlc-copilot.test.mjs`. If a Claude reference survives the rewrite, add a `REWRITES` rule.
- [x] **Step 6: Commit.** `git commit -m "docs(process): breakdown thresholds, split_from and after"`

### Task 5: Skills

**Files:**
- Modify: `skills/write-feature-request/SKILL.md`
- Modify: `skills/select-next-task/SKILL.md`

**Interfaces:**
- Consumes: the **Breakdown** section (Task 4), and the `sdlc claim` `blocked` refusal (Task 2).

- [x] **Step 1: `write-feature-request`, add Step 1.5 "Size check"**, as in design §1:
  - the five signals;
  - the split rule (verbatim from Global Constraints);
  - merging slices below `min_slice_criteria`;
  - always record the result in `## Sizing` (one dated line, in the format from design §1).
- [x] **Step 2: `write-feature-request`, add slicing and triage,** as in design §2–§4:
  - the slicing guidance in order of preference;
  - for each proposed slice, show slug, goal, criteria count, `after`, and which criteria went where;
  - the split decision (accept, edit, decline) before any file is written;
  - per-slice ACCEPTED, PARKED or REJECTED;
  - the slice frontmatter and `## Triage` format, with "split at intake" when there's no original file;
  - `split_from` must not name an existing feat-req.
- [x] **Step 3: `write-feature-request`, add re-check mode**, as in design §5:
  - triggered by `/write-feature-request <existing-slug>`;
  - preconditions: the feat-req is `ACCEPTED`; in board mode, no live claim by another and no open `awaiting`, checked with `node scripts/sdlc.mjs status --json` after a pull; stop otherwise;
  - on a confirmed split, `git rm` the original in the same change, and cite `git log -1 --format=%h -- docs/feat-req/<slug>.md`;
  - with no split, append a re-check line to `## Sizing`.
- [x] **Step 4: `write-feature-request`, update the template and constraints.**
  - In the template, add `## Sizing` after Success Metrics, and the optional `split_from` / `after` frontmatter.
  - Replace the constraint "A large feature … is still one spec here" with: "A large request is split at intake when the size check says so (Step 1.5); plan breakdown handles size found later."
  - Add a headless note: post the ordinary triage gate with the proposed slices in its Context, and never split headless.
- [x] **Step 5: `select-next-task`.**
  - In Step 1 "Otherwise", exclude a candidate whose `after` items aren't all `IMPLEMENTED`.
  - Under Step 3's user override, add one line: the override doesn't bypass `after`; edit `after` instead.
  - In Step 6, add `blocked` to the list of claim refusals, so the skill tells the user what the effort waits on.
- [x] **Step 6: Run `npm test`.** Expected: all pass, including the Copilot rewrite test.
- [x] **Step 7: Commit.** `git commit -m "feat(skills): size check, slicing and re-check in write-feature-request; after in select-next-task"`

### Task 6: Walk-through and full verification

**Files:**
- Create: `docs/history/<timestamp>_feature-request-breakdown.md` (via `/write-history-entry`)

- [x] **Step 1: Walk-through (a), no split.** Run `/write-feature-request` on a small throwaway idea in a scratch copy of the repo. Expected: the spec's `## Sizing` line ends `→ no split`.
- [x] **Step 2: Walk-through (b), split at intake.** Use a deliberately large idea with three independent parts: accept the split, accept two slices, park one. Expected:
  - three files, each with `split_from` and the Triage record "split at intake";
  - no file for the original idea;
  - `node scripts/render-status.mjs` shows `## Splits` with the correct counts.
- [x] **Step 3: Walk-through (c), re-check split.** Run `/write-feature-request <slug>` on an accepted large request. Expected: the original is removed in the same change, and each slice cites the commit.
- [x] **Step 4: Walk-through (d), refusal.** In a board-mode scratch meta-root, run a re-check on an effort claimed by someone else. Expected: the skill stops and names the holder.
- [x] **Step 5: Run `npm test`.** Expected: all pass.
- [x] **Step 6: Record the walk-through outcomes** in the history entry, citing acceptance criteria by text.
- [x] **Step 7: Commit.** `git commit -m "docs(history): feature request breakdown walk-through"`

## Pull Requests
| key | branch | PR | state |
|---|---|---|---|
| sdlskills | feat/feature-request-breakdown | — | not started |
