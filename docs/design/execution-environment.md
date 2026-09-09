---
feat_req: docs/feat-req/execution-environment.md
date: 2026-09-09
status: APPROVED
---

# Multi-repo execution environment

## Context

The kit assumes one repository. Real work spans a few to many. [`docs/feat-req/execution-environment.md`](../feat-req/execution-environment.md) asks for a way to catalog repos, assemble the subset an effort needs, bind repos to an effort through the lifecycle, and coordinate a change that spans several repos (branches, PRs, merge order, a combined "done" state).

Constraints that bound the solution:
- Must not regress the single-repo experience — N=1 is a degenerate case of the same machinery, not a second mode.
- Skills are symlinked from the kit into `.claude/skills/`, so all per-project state (catalog, `workspace/`) lives at the meta-root, never in a skill.
- v1 assumes git + GitHub + an authenticated `gh` CLI. No submodules. No meta-VCS tool.
- Single-worker assumption from [`docs/kit-open-items.md`](../kit-open-items.md) holds — one effort in flight.

The 12 Open Questions in the feat-req were resolved with the user on 2026-09-09; their answers are folded into Proposed Design below.

## Proposed Design

### Meta-root layout

The adopter's project is a **meta-root** — its own private git repo:

```
<meta-root>/                    # git repo: the kit + the trail
├── CLAUDE.md                   # references CLAUDE.process.md + CLAUDE.stack.md
├── CLAUDE.process.md
├── CLAUDE.stack.md
├── repos.yml                   # the repository catalog (structured)
├── repos/                      # optional per-repo deep notes
│   └── <key>.md
├── .claude/skills/             # symlinked from the kit
├── scripts/
│   ├── render-status.mjs
│   ├── assemble-env.mjs        # NEW
│   └── clean-env.mjs           # NEW
├── docs/                       # the trail — feat-req, design, plans, history, decisions, STATUS.md
└── workspace/                  # git-ignored; per-effort code checkouts
    ├── .current-effort         # NEW: marker file, holds the effort slug
    └── <key>/                  # a normal clone of the repo, own git history
```

`workspace/` is added to `.gitignore`. Each checkout under it is an independent clone with its own history and its own remote.

### Repository catalog — `repos.yml`

```yaml
# repos.yml — repository catalog. One entry per repo the project works across.
# Consumed by: assemble-env.mjs, the Design phase (repo selection), select-next-task.
repos:
  <key>:                        # short handle, used as the effort-agnostic repo id everywhere
    url:            <clone url>          # required
    default_branch: <branch>             # required
    domain:         backend|frontend|infra|shared-lib|service|...   # required
    summary:        >                    # required — a paragraph: what it is, what lives in it
      ...
    responsibilities:                    # required — what this repo owns
      - ...
    depends_on:     [<key>, ...]         # default []  — other repos it integrates with
    keywords:       [<term>, ...]        # default []  — match hints for repo selection
    notes:          false                # default false — true iff repos/<key>.md exists
```

Validation: `assemble-env.mjs` checks the schema before doing anything; `setup-sdlc` runs the same check after building the file.

### Repo selection procedure (Design phase)

The Design phase resolves which repos an effort touches. It is an **output of design**, not a precondition — the set starts provisional and converges.

1. Read `repos.yml`. For each repo, compare the effort against `summary` + `responsibilities` + `keywords`.
2. **Clear yes** → in scope. **Clear no** → out. **Ambiguous** → read `repos/<key>.md` (if `notes: true`); re-judge. **Still ambiguous** → ask the user.
3. Pull in `depends_on` repos of any in-scope repo as *candidate consumers* and judge them the same way (this is how contract changes find their affected consumers).
4. Assemble the provisional set into `workspace/` (`assemble-env.mjs` — see below) so code can be read during design.
5. As design proceeds, add/drop repos; re-run `assemble-env.mjs` to match.
6. **At approval the set is locked** into the design doc: `repos:` frontmatter (list of keys) + the `## Repositories in Scope` section (why each is in, which *owns* the change, which are *affected consumers*, the integration contract between them).

A repo that surfaces mid-Development and isn't in the approved `repos:` list → stop, add it to the design doc's `repos:` and `## Repositories in Scope` with a dated note, re-run `/classify-change` for it, get a lightweight re-approval (the design changed). Not a full Design redo.

### Scripts

**`assemble-env.mjs <effort-slug>`** — idempotent workspace reconstruction.
- Reads `docs/design/<effort-slug>.md` frontmatter `repos:`. (Before a design doc exists, takes repo keys as extra CLI args.)
- For each key: if `workspace/<key>/` absent → `git clone --depth 1 <url>`; if present → `git fetch`.
- Checks out `feat/<effort-slug>` in each (creates it from `default_branch` if missing).
- Writes `workspace/.current-effort` = `<effort-slug>`.
- If `.current-effort` already names a *different* effort → warns, lists the stale repos, reassembles for the requested effort (does not delete the others).
- Exits non-zero on schema-invalid `repos.yml` or a clone/auth failure.

**`clean-env.mjs [<key> ...]`** — removes `workspace/<key>/` checkouts (all, or the named ones), clears `.current-effort` if emptied. Never touches un-pushed work without `--force`.

Both: Node built-ins + `git`/`gh` shell-outs + **one dependency, `yaml`** (for parsing `repos.yml` — nested structure that a hand-rolled parser can't handle safely; see ADR 004). Same style as `render-status.mjs`. Private-repo auth is whatever `git`/`gh` already holds — documented prerequisite, no credential handling in the scripts. The meta-root gets a `package.json` with `yaml` as its only dependency; `setup-sdlc` runs `npm install`.

### Path convention

Every file reference in every artifact (design docs, plans, history entries, review targets) is **`<key>:<repo-relative-path>`** — e.g. `api:src/offers/offers.service.ts`. `entry_points` in `repos/<key>.md` use the same form. A bare path with no `<key>:` means the meta-root.

### Per-skill changes

| Skill | Change |
|---|---|
| `setup-sdlc` | New step: build `repos.yml` by interview (name each repo, its URL, default branch, domain, a summary paragraph, responsibilities, dependencies). N=1: auto-generate the single entry from the repo URL + its README, one confirmation. Adds `workspace/` to `.gitignore`, creates `scripts/assemble-env.mjs` + `clean-env.mjs` (or notes they ship with the kit). |
| `write-design-doc` | New Step 2.5: run the repo selection procedure; assemble the provisional set. New required section `## Repositories in Scope`. New frontmatter `repos:`. Step 6 locks the set. |
| `classify-change` | Runs **per repo** in the approved `repos:` list. Emits one verdict per repo. Effort tier = highest. `hotfix` stays effort-level, never a per-repo tier. |
| `write-execution-plan` | New anchored sections: `## Repositories` (per repo: role = owner\|consumer, tier) and `## Pull Requests` (`key │ branch │ PR URL │ state`, filled during execution). Inherits `repos:` from the design doc. |
| Development phase (`executing-plans`) | Starts by running `assemble-env.mjs <effort>` (branches `feat/<effort>` across all effort repos up front). PR per repo opened at the end of that repo's plan work. Checkpoints stay at plan-phase boundaries, not per-repo. |
| `write-history-entry` | New `## Per-Repo Summary` table: `key │ tier │ branch │ PR │ what changed`. Narrative stays single. |
| `select-next-task` | When resuming an effort, runs `assemble-env.mjs <effort>` first. Reads repo/PR state from the plan's `## Pull Requests`. |
| `close-out` | Reads the design doc's `### Merge order`. Verifies **every** effort repo has a **merged** PR via `gh pr view` before flipping `status: IMPLEMENTED`. New DoD item. Prints `run: node scripts/clean-env.mjs` as its last line. |
| `gather-open-items` | Repo-relative paths in extracted items carry the `<key>:` prefix. |

### `CLAUDE.process.md` changes

- New `## Working in the meta-root` section: open your editor on `workspace/<key>/` for hands-on code; the agent `cd`s per-repo for all stack commands; the meta-root is orchestration + artifacts only; never run bare `git`/test/build at the meta-root.
- Definition of Done gains: "A merged PR in every repo listed in the plan's `## Repositories`; links recorded in `## Pull Requests`; merge order per the design doc's `### Merge order`."
- Artifacts table gains `repos.yml` and `repos/<key>.md`.
- State table note: `select-next-task` assembles the workspace before routing.

### `render-status.mjs` changes

Parses each plan's `## Pull Requests` section; shows per-effort PR progress (`3/5 merged`) in the Active sections of `docs/STATUS.md`. Does not trust it for the Implemented transition — that's `close-out`'s live `gh` check.

## Data Model & Schema Changes

None — no database. The one new structured artifact is `repos.yml`; its schema is defined in Proposed Design → *Repository catalog*. A `package.json` is added at the meta-root with one dependency, `yaml` (ADR 004).

## API Surface Changes

None — no HTTP API. Two new CLI entry points:
- `node scripts/assemble-env.mjs <effort-slug> [<extra-repo-key> ...]`
- `node scripts/clean-env.mjs [<key> ...] [--force]`

Both defined in Proposed Design → *Scripts*.

## UI/UX Changes

- `docs/STATUS.md` (generated) gains a per-effort PR-progress column in the Active sections. Plain-text markdown table — the existing STATUS.md conventions apply.
- The landing page (`site/index.html`) gains a short "multi-repo" explanation and points at the 2-repo example (BRAINSTORMING.md §3). Must conform to the drafting-set visual system already established there; no new `STYLE_GUIDE.md` since the site has its own committed design.

## Alternatives Considered

- **Git submodules for `workspace/`** — version-pinned and reproducible, but painful to add/remove per-effort and fights the "provisional, evolving repo set" model. Rejected. → ADR 001.
- **Per-effort `workspace/<effort>/<repo>/` dirs** — allows parallel efforts, but wastes disk under the single-worker assumption and duplicates checkouts. Deferred; it's the natural upgrade if parallel agents land. → ADR 001.
- **Co-located meta-root for N=1** (kit + `docs/` inside the single code repo) — one repo for solo users, but forces every skill to carry two path models forever. Rejected. → ADR 002.
- **Multi-repo as an opt-in mode** (single-repo stays the default code path) — avoids indirection for the common one-repo case, but means two divergent code paths in every skill and a permanent fork in the process contract. Rejected: multi-repo is the real-world default; N=1 is one catalog entry. → ADR 002.
- **A separate cross-repo change-set manifest** — cleaner separation of "plan" (intent) from "PR state" (reality), but a new document per effort in a kit that is explicitly fighting artifact overload. Rejected: fold PR tracking into the plan (which is already a living doc during execution); `close-out` verifies live. → ADR 003.
- **Repo binding at intake** (feat-req carries `repos:`) — rejected: which repos implement a product request is a technical/architecture decision that belongs in Design, and the set changes as the design develops.
- **Catalog auto-draft from a GitHub org at setup** — fast for large orgs, but produces shallow entries for repos you may never touch. Deferred to a follow-up ("option D"); v1 is interview-only.
- **Catalog as `repos.json` / hand-rolled YAML parser** — to keep the scripts strictly zero-dependency. Rejected: JSON taxes the humans who edit the catalog (multi-paragraph `summary` fields), and a hand-rolled parser is a permanent maintenance liability. Added `yaml` as the meta-root's one dependency instead. → ADR 004.

## Testing Strategy

- **Script unit tests** — `assemble-env.mjs` / `clean-env.mjs` against a temp dir with fake local "remotes" (`git init --bare`): idempotency, `.current-effort` mismatch handling, missing-repo clone, schema rejection. Covers feat-req AC "assemble-env is idempotent … detects a mismatch".
- **`repos.yml` schema validator** — table-driven: valid file passes, each missing required field fails with a clear message. Covers AC "setup-sdlc produces a schema-valid repos.yml".
- **Skill-delta checks** — an artifact-validation script (extends the one BRAINSTORMING.md §3 proposes): given a design doc, assert `repos:` frontmatter present and every key resolves in `repos.yml`; given a plan, assert `## Repositories` and `## Pull Requests` anchors exist and are parseable. Covers the "anchored sections parseable by render-status.mjs" AC.
- **`render-status.mjs`** — fixture plan with a `## Pull Requests` table of mixed state → asserts `2/3 merged` in output.
- **End-to-end** — the 2-repo example project (BRAINSTORMING.md §3) is the integration test: run one cross-repo feature request → implemented, assert the trail is well-formed and both PRs are referenced. This is deferred with §3, not blocking v1.
- No test DB — the kit has no database.

## Rollout & Migration

Implementation order (each independently shippable):

1. Meta-root `package.json` + `yaml` dep. `repos.yml` schema + validator + `assemble-env.mjs` / `clean-env.mjs` + tests. Nothing consumes them yet.
2. `setup-sdlc` catalog step + `.gitignore` / `workspace/` wiring.
3. `write-design-doc`: selection procedure, `## Repositories in Scope`, `repos:` frontmatter, Step 6 lock.
4. `write-execution-plan`: `## Repositories` + `## Pull Requests` sections. `classify-change` per-repo.
5. Development wiring (`assemble-env` on start, branch-all-up-front) + `write-history-entry` `## Per-Repo Summary`.
6. `close-out` merge-order read + live `gh` PR verification + DoD item. `select-next-task` assemble-on-resume.
7. `render-status.mjs` PR-progress parsing. `CLAUDE.process.md` prose (Working in the meta-root, DoD, artifacts table). Landing-page copy.
8. `docs/design/architecture.md` created/updated to describe the meta-root model (this is where the "architecture.md updated in the same change" DoD item is satisfied — during implementation, not now).

**`### Merge order`** convention: an ordered list of repo keys under that fixed subheading in the design doc's Rollout & Migration section, one line of reason per step. `close-out` reads it.

**Existing single-repo adopters:** migration is `setup-sdlc --migrate` (or manual) — create a meta-root, move the code repo into `workspace/<key>/`, generate the one `repos.yml` entry, move `docs/` up. Out of scope for v1 as automated tooling; documented as steps.

## Security Considerations

No security-relevant application changes. Notes:
- The scripts shell out to `git` and `gh`; auth is entirely delegated to those tools' existing credentials. The kit stores and handles no secrets.
- `assemble-env.mjs` clones URLs listed in `repos.yml` — the user controls that file; treat it like any config that names remotes. The script should refuse non-`https://`/`git@` schemes.
- One new dependency, `yaml` (ADR 004) — a widely-used, actively-maintained parser with no transitive dependencies. Pin it in `package.json`.
- No `/security-review` trigger applies (no auth logic, no external endpoint, no data-access control, no API-key handling).

## Open Items

- [ ] Interaction with the parallel-agents work in `docs/kit-open-items.md` — per-effort `workspace/` dirs become necessary there; `.current-effort` is a single-worker shortcut.
- [ ] Catalog auto-draft from a GitHub org ("option D") — follow-up feature request.
- [ ] Repo-level documentation standard (BRAINSTORMING.md §5) — the catalog's `repos/<key>.md` should point at it once it exists rather than duplicating.
- [ ] The 2-repo example project + end-to-end test (BRAINSTORMING.md §3).
- [ ] Automated `setup-sdlc --migrate` for existing single-repo adopters.
- [ ] Non-GitHub hosts (GitLab, Bitbucket) — `gh`-specific calls in `close-out` and Development would need an abstraction.
- [ ] `git worktree` instead of separate clones for repos already present on disk — possible optimization, unevaluated.
