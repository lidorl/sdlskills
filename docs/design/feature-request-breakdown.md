---
feat_req: docs/feat-req/feature-request-breakdown.md
date: 2026-11-24
status: APPROVED
repos: [sdlskills]
---

# Breakdown at the feature request phase

## Context

The feature request ([`docs/feat-req/feature-request-breakdown.md`](../feat-req/feature-request-breakdown.md)) asks for a sizing check on every new feature request. When the request is large, the check proposes 2–5 vertical slices, which a person confirms at triage. The slices replace the original request, with no umbrella file, and each slice records the split. The queue never starts a slice before its `after` items are `IMPLEMENTED`. Accepted requests are re-checked only when a person invokes the check.

What exists today:
- **`skills/write-feature-request/SKILL.md`**: a product interview (Step 1), writing one spec (Step 2), triage (Step 3) and hand-off (Step 4). Its Constraints say "a large feature … is still one spec here".
- **`scripts/lib/board/queue.mjs`**: `loadEfforts()` reads every feat-req's frontmatter with the real YAML parser. `rank()` filters candidates by status, live claim and open `awaiting`, then sorts. Both `sdlc next` (`cli.mjs:153`) and the worker loop (`loop.mjs:235`) take their pick from `rank()`, so one filter there covers both.
- **`scripts/lib/board/claims.mjs`**: the claim write refuses with `gone`, `closed`, `awaiting`, `held` or `mismatch`. Nothing checks ordering between efforts.
- **`skills/select-next-task/SKILL.md`**: in board mode it uses `sdlc next`. Without a board, it ranks by hand from frontmatter (Step 1 "Otherwise", Step 3).
- **`scripts/render-status.mjs`**: a flat `key: value` frontmatter parser (lists come back as raw strings). It renders STATUS.md tables by status and writes `.status.json`.
- **Headless intake.** Workers never run `write-feature-request`. The only feat-reqs created headlessly are follow-ups written by `effects.mjs` from a clarification correction, as a stub spec plus a `triage` gate whose answers are `accept | park | reject`. In practice the sizing check never runs in a headless worker today.

Constraints that bound the solution:
- No new runtime dependency.
- Skills and `CLAUDE.process.md` stay in sync, and new skill wording must pass the Copilot rewrite test.
- The name `depends_on` is taken by `repos.yml`.
- The artifact trail must not grow much (BRAINSTORMING §6).

## Proposed Design

### 1. The sizing check (skill, every new request)

A new **Step 1.5: Size check** in `write-feature-request`, after the interview and before anything is written. It always runs. There is no setting to turn it off.

The agent counts or estimates five signals from the interview:

| Signal | How |
|---|---|
| `criteria` | number of acceptance criteria drafted |
| `personas` | number of distinct personas |
| `repos` | number of repos the request touches (from `repos.yml`) |
| `files` | rough estimate of files changed |
| `independent_parts` | the parts of the request that would each deliver value on their own, named |

**Rule:** propose a split when **at least one size signal exceeds its threshold, and there are at least two independent parts**. Without independent parts, there's nothing to slice vertically, so the request stays whole even if it's big. Plan breakdown (a separate request) handles that size later.

**Minimum size:** a proposed slice must have at least `min_slice_criteria` acceptance criteria (default 3). Smaller slices are merged into a neighbour before they're proposed. If that leaves fewer than two slices, there's no split.

Thresholds live in a new `breakdown:` block in `CLAUDE.process.md`, next to the Autonomy Policy. The skill already reads that file.

```yaml
breakdown:
  feature_request:            # the check always runs; these only tune it
    max_criteria: 12
    max_personas: 3
    max_repos: 2
    max_files: 30
    min_slice_criteria: 3
```

The defaults lean low on purpose (decided at design review, 2026-11-24). Against the kit's own trail, the workers spec (36 checkboxes) trips the check, and so do the verification and coordinator specs (16 criteria each). Whether those last two would actually be split depends on the second condition, independent parts, and the person still confirms any split at triage. A false proposal costs one declined split. A missed one costs a mega-effort.

**The result is always recorded** in a new `## Sizing` section of the spec template, placed after Success Metrics:

```markdown
## Sizing
- 2026-11-24: 9 criteria, 2 personas, 1 repo, ~15 files; independent parts: none → no split.
```

When a split is confirmed, each slice's `## Sizing` line names the split instead. When a split is declined, the line says "split proposed, declined: <reason>".

### 2. Proposing slices

When the rule fires, the agent proposes 2–5 slices using the slicing guidance, in order of preference:
1. vertical slices that each deliver user value;
2. a thin first slice that proves the path end to end;
3. slices by repo or layer, only when there's no other way.

Each proposed slice has:
- a slug;
- a one-line goal;
- its scenarios and acceptance criteria, taken from the interview (nothing invented);
- its `after` list: the slices it needs first, if any.

The agent states which criteria went to which slice, so nothing is dropped or duplicated.

### 3. Triage with a split (Step 3)

The triage stop gains one decision before the usual per-spec one:
1. **Split?** The person accepts the split, edits it (merging, moving criteria, renaming, reordering `after`), or declines it.
   - **Declined:** one spec is written as today, and `## Sizing` records the declined split and the reason.
2. **Per slice:** ACCEPTED, PARKED or REJECTED, with the existing rules. Parking one slice doesn't park the others.

Only after step 1 is settled does Step 2 write files. For a confirmed split, it writes one file per slice and no file for the original idea.

### 4. Slice records

Each slice is an ordinary feat-req with two extra frontmatter fields and a `## Triage` entry:

```yaml
split_from: workers            # the original idea's slug; a label, never a file
after: [workers-registry]      # slugs that must be IMPLEMENTED first; omitted when empty
```

```markdown
## Triage
**ACCEPTED** (2026-11-24). Split from `workers` on 2026-11-24.
- **Reason for the split:** <why>
- **Slices:** `workers-registry`, `board-claims` (after `workers-registry`), `board-requests` (after `board-claims`).
- **Original text:** commit `<sha>`, `docs/feat-req/workers.md`.   ← re-check only
```

- **`split_from` must not name an existing feat-req file.** At intake it's the slug the idea would have had. On a re-check, the original file is deleted in the split commit, so the name is free again.
- **"Original text" exists only for a re-check.** At intake, the original request was never written, so there's no commit to point to. The slice's Triage says "split at intake" instead, and the shared "why" is carried in each slice's Problem & Context. This is a deliberate amendment of the acceptance criterion "the commit with the original text", which can't hold for a split at intake.

### 5. Re-checking an accepted request (explicit only)

`/write-feature-request <existing-slug>` on a feat-req that already exists enters **re-check mode**:
1. Load the spec, skip the interview, and run Step 1.5 on what the spec says.
2. **Preconditions:** the feat-req is `ACCEPTED` (not designed yet, so nothing downstream refers to it).
   - In board mode, it has no live claim held by someone else and no open `awaiting`. The skill checks with `node scripts/sdlc.mjs status --json` after a pull, and stops if either holds.
3. Propose and triage exactly as above.
4. **On a confirmed split:** write the slices and `git rm` the original in the same change. Each slice's Triage cites the last commit that contained the original file (`git log -1 --format=%h -- docs/feat-req/<slug>.md`).
5. **No split:** append a `## Sizing` line ("re-checked <date>: no split"), and nothing else changes.

The check never runs on its own on an accepted request. Neither `select-next-task` nor `write-design-doc` calls it.

### 6. Queue: `after` blocks selection and claims

- **`loadEfforts()`** keeps `fm.after` as is, and reports a problem for any `after` entry that isn't a valid slug or doesn't name an existing feat-req. That surfaces through `sdlc check`.
- **`rank()`** builds a `slug → status` map from the same `efforts` list and drops any effort whose `after` contains a slug not `IMPLEMENTED`. An unknown slug counts as not done, so a typo blocks rather than silently passing. This covers `sdlc next` and the worker loop together.
- **`claims.mjs`** gets a new refusal, `blocked`, in the claim `mutate`: it reads each `after` slug's status from the same tree and refuses unless all are `IMPLEMENTED`. The CLI prints "blocked: waiting on <slug> (<status>)". This closes the race where a slice is claimed directly or picked from a stale ranking.
- **`select-next-task`** without a board: Step 1 excludes a candidate whose `after` items aren't all `IMPLEMENTED`, and Step 3's user override can't bypass it. To start a blocked slice anyway, a person edits its `after` list, which is an explicit, recorded act.

A slice whose `after` names a `PARKED` or `REJECTED` effort stays blocked. STATUS.md flags it (below) so a person can fix the `after` list.

### 7. STATUS.md: a Splits section

`render-status.mjs`:
- **Parsing:** `parseFrontmatter` learns one more shape, a flow list `[a, b]`, for `after`. It stays dependency-free.
- **A new `## Splits` section,** after Active, rendered only when any feat-req has `split_from`. One block per `split_from`:

  ```
  ### workers — 1 of 3 implemented
  | Slice | Status | After | Blocked by |
  | workers-registry | IMPLEMENTED | - | |
  | board-claims | IN_PROGRESS | workers-registry | |
  | board-requests | ACCEPTED | board-claims | board-claims (IN_PROGRESS) |
  ```

  This also answers the spec's open question about showing progress without a parent record.
- **Existing tables:** slices still appear in them by status. A blocked slice's Status cell gets a `(blocked)` suffix.
- **`.status.json`:** each feature row gains `split_from` and `after`.

### 8. Headless

Workers never run `write-feature-request` today, so no headless split path is built. If a future change runs the skill headless (`SDLC_HEADLESS=1`), the skill instructs:
- run the sizing check;
- record the result;
- when it proposes a split, post the ordinary `triage` gate with the proposed slices in its Context section, with no new answer kind;
- the person can accept the request whole, park or reject it, or split it later with the explicit re-check.

This amends the acceptance criterion "in a headless worker, a proposed split is posted as a triage request with the slices as options". The slices are shown, but splitting is done interactively, because applying a split deletes the effort a worker holds, which the worker protocol doesn't support (see Alternatives).

### 9. Contract and skill edits

- **`CLAUDE.process.md`:**
  - the new `breakdown:` block;
  - the State section documents `split_from` and `after`;
  - Workers and the board: "a claim is refused while an `after` item isn't `IMPLEMENTED`".
- **`write-feature-request`:**
  - Step 1.5 (size check);
  - slicing guidance;
  - triage with a split;
  - re-check mode;
  - template gains `## Sizing` and the optional `split_from` / `after` fields;
  - the "still one spec" constraint is replaced by "a large request is split at intake when the size check says so; plan breakdown handles size found later".
- **`select-next-task`:** the `after` exclusion in Step 1, and a note under the user override.

## Data Model & Schema Changes

Frontmatter only, no database:
- **feat-req, new optional fields:**
  - `split_from: <slug>`, a label for the original idea;
  - `after: [<slug>, …]`, slugs that must be `IMPLEMENTED` before this effort can be selected or claimed.
- **feat-req template, new section:** `## Sizing` (always present on new specs).
- **`CLAUDE.process.md`, new config block:** `breakdown.feature_request.{max_criteria, max_personas, max_repos, max_files, min_slice_criteria}`.
- **`.status.json`:** feature rows gain `split_from` and `after`.

No migration: existing feat-reqs have neither field, and every reader treats their absence as "not a slice, no ordering". `docs/design/data-model.md` doesn't exist in this repo. These fields are documented in the State section of `CLAUDE.process.md`.

## API Surface Changes

- **`sdlc claim <slug>`:** a new refusal, `blocked`, with exit code 1 and the message "blocked: waiting on <slug> (<status>)". `--json` output gains `"refusal": "blocked"` and `"waiting_on": [...]`.
- **`sdlc next` and the worker loop:** never return or pick a blocked effort (through `rank()`).
- **`sdlc check`:** reports invalid or unknown `after` entries as problems.
- **`/write-feature-request <existing-slug>`:** the new re-check mode.

No auth changes. Board writes keep going through `boardWrite`.

## Repositories in Scope

N/A. This is a single-repo effort: `sdlskills` owns every change (skills, `CLAUDE.process.md`, `scripts/lib/board/`, `scripts/render-status.mjs`).

## UI/UX Changes

- **The triage conversation** gains the split decision. Before any file is written, the agent shows the proposed slices: slug, goal, criteria count, `after`, and which criteria went where. The person can accept, edit or decline.
- **STATUS.md** gains the `## Splits` section and the `(blocked)` suffix.
- **The CLI** gains the `blocked` claim refusal message.

This repo has no `docs/design/STYLE_GUIDE.md`, so no style-guide sections apply.

## Alternatives Considered

- **Who runs the check: agent judgment versus a script.** A script can't count acceptance criteria before the spec exists, or judge "independent value". The agent runs the check against configured thresholds and records the signals, so the decision can be audited. *Chosen: the agent, with thresholds in config and the result recorded.*
- **When to propose a split: any threshold exceeded, versus "threshold exceeded and at least two independent parts".** Size alone would propose splits that have no vertical seam, which leads to layer slices and the overhead the spec warns about. *Chosen: both conditions.*
- **Where the thresholds live: `board/config.yml`, a new kit config file, or `CLAUDE.process.md`.** `board/config.yml` only exists in board mode, but the check must run without a board. A new file adds a format. *Chosen: a `breakdown:` block in `CLAUDE.process.md`*, beside the Autonomy Policy, which the skill reads already and which plan breakdown will extend with `breakdown.plan`.
- **Enforcing `after`: in `rank()` only, versus also in the claim.** `rank()` alone leaves a race (a stale ranking) and lets a direct `sdlc claim` start a blocked slice. *Chosen: both*, with the claim refusal as the guarantee and `rank()` to avoid wasted claim attempts.
- **Letting the user override bypass `after`.** It would make `after` advisory. *Chosen: no bypass.* Editing `after` is the override, and it leaves a record.
- **Headless split as a fourth triage answer (`split`), applied by the next claimant.** Applying it means an agent writes the slices and deletes the effort the worker holds. The worker's outcome handling checks the reported phase against the working feat-req, and releasing or reporting needs that file. Supporting a held effort that disappears is a protocol change for a path that never runs today. *Rejected for now; recorded as an open item.*
- **Keeping the original as a stub with `status: SPLIT`.** The feature request decided against any umbrella file. *Not considered further.*

No ADR: these choices are local to this feature and reversible.

## Testing Strategy

| Test | Level | Covers |
|---|---|---|
| `queue.test.mjs`: `rank()` drops an effort whose `after` has a non-`IMPLEMENTED` or unknown slug, and keeps it once all are `IMPLEMENTED` | unit | AC "not ranked by `rank()`" |
| `queue.test.mjs`: two slices with no `after` link are both ranked | unit | AC "claimed in parallel" (ranking side) |
| `queue.test.mjs`: `loadEfforts()` reports invalid and unknown `after` entries | unit | supports `sdlc check` |
| `claims.test.mjs`: a claim on a blocked slice is refused `blocked`, and succeeds after the `after` effort is `IMPLEMENTED` on main; two independent slices are claimed by two workers | integration (fixture remotes, as existing tests) | AC "not claimed", "claimed in parallel" |
| `cli.test.mjs`: `sdlc claim` prints the `blocked` message and `--json` fields; `sdlc next` skips a blocked slice | integration | API changes |
| `render-status.test.mjs`: the Splits section, progress count, `(blocked)` suffix, flow-list `after` parsing, `.status.json` fields, and no section when there are no slices | unit | AC "STATUS.md groups slices" |
| `install-sdlc-copilot.test.mjs` (existing, `npm test`) passes with the new skill wording | existing suite | contract and skills in sync |
| Skill walk-through (manual, recorded in the history entry): (a) a small request records "no split"; (b) a large request proposes slices, triage accepts two and parks one, files are written with `split_from`, `after` and Triage; (c) a re-check of an accepted request splits it and removes the original; (d) a re-check refuses on a claimed effort in board mode | manual | AC on proposing, recording, re-check, "no file remains" |

Fixtures: extend `scripts/lib/board/fixtures.mjs` with feat-reqs carrying `after` and `split_from`.

## Rollout & Migration

- No data migration. Existing feat-reqs are unaffected (no `after`, no `split_from`).
- Ship the code (queue, claims, render-status) and the skill and contract changes in one PR, so a slice with `after` can't be written before the queue respects it.
- Adopters receive the skill and contract changes when they re-run the installer. The `breakdown:` block is part of `CLAUDE.process.md`, which the installer replaces, so adopters who tuned thresholds re-apply them. This is noted in the README's upgrade notes.

## Security Considerations

No security-relevant changes. No auth, external endpoints, data-access control or API-key logic is involved. `after` and `split_from` values are validated against the existing slug pattern (`SLUG_RE`) before use in paths, as other slugs already are.

## Open Items

- [ ] Headless split as a triage answer: deferred. It needs worker support for an effort that is deleted while held (see Alternatives).
- [ ] Threshold defaults (12 criteria, 3 personas, 2 repos, 30 files) are set low on purpose and checked against three specs only. Revisit after the first few real proposals, especially if declined splits are frequent.
- [ ] Contracts shared between slices built in parallel: v1 relies on the slicing guidance and the follow-up-request path. Nothing enforces consistency.
- [ ] Adopters who tuned `breakdown:` lose their values when the installer replaces `CLAUDE.process.md`. Consider moving tunables to an adopter-owned file if this bites.
- [x] Amended acceptance criteria folded back into the feat-req on approval (2026-11-24).
