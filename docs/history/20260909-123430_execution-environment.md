---
date: 2026-09-09
tier: standard
feat_req: docs/feat-req/execution-environment.md
plan: docs/plans/execution-environment-1.md, docs/plans/execution-environment-2.md
repos: [sdlskills]
---

# Multi-repo execution environment

Implemented both plans in one session (20 commits since `8770996 Initial commit`). The kit dogfooded its own lifecycle: feat-req → design (+ ADRs 001–004) → 2 plans → development → code review → security review → close-out.

## Per-Repo Summary
| key | tier | branch | PR | what changed |
|---|---|---|---|---|
| sdlskills | standard | `main` (bootstrap — no PR workflow yet) | — | catalog + `assemble-env`/`clean-env` scripts + all 9 phase skills + `CLAUDE.process.md` + `render-status.mjs` + landing page |

## Deviations
- **Git bootstrap.** Repo was not under version control. Ran `git init`, made a baseline commit, worked on a feature branch, then (at the user's request, since the repo had no initial commit and needed to be pushable) fast-forwarded to `main` and squashed to a single `Initial commit`. Remaining work committed directly to `main`.
- **`package.json` name** is `sdlskills`, not the plan's `sdlskills-meta-root` — this repo *is* the kit.
- **Test runner** is `node --test "scripts/**/*.test.mjs"` (glob), not `node --test scripts/` — Node 24 treats a bare directory arg as a module to execute.
- **URL-scheme check consolidated.** Plan 1 Task 3's test code assumed `assemble()` re-checks the URL scheme; that duplicated `validateCatalog` and conflicted with local-path test fixtures. The check now lives only in `validateCatalog`; `assemble()` tests pass an explicit in-memory `catalog`.
- **Design doc revised mid-plan** (still `APPROVED`, user re-confirmed): added the `yaml` dependency + ADR 004 when planning surfaced that nested `repos.yml` can't be hand-parsed safely.
- **`repos:` frontmatter + `## Repositories in Scope`** added retroactively to the already-approved `execution-environment.md` design doc for corpus consistency with the new `write-design-doc` format.

## Discoveries
- `render-status.mjs` already excluded `architecture`/`data-model`/`STYLE_GUIDE` but not `STYLE_GUIDE.template` — the "2 design docs" miscount. Fixed in Plan 2 Task 9.
- `git clone --depth 1` implies `--single-branch`, so a resumed effort would never see its pushed `feat/<slug>` branch — caught in code review, fixed with explicit-base checkout.
- `git log --branches --not --remotes` lists *all* commits when a repo has no remote, so `clean-env`'s original protection check flagged every no-remote checkout. Test fixtures updated to clone from bare remotes; production behaviour is correct.

## Decisions
- 4 ADRs: meta-root + git-ignored `workspace/` of plain clones (001); multi-repo as default, N=1 degenerate (002); PR coordination folded into the plan (003); `yaml` as the one dependency (004).
- Code review: all 7 findings fixed (not deferred) — see `fix: address code-review findings`.
- Security review: no HIGH/MEDIUM. One defensive hardening applied (repo-key format constraint against `workspace/` traversal).

## Step Status
- Plan 1 (Foundation): all 5 tasks done.
- Plan 2 (Lifecycle integration): all 10 tasks done. `gather-open-items` `<key>:` path-prefix folded into the path-convention notes rather than its own task (flagged in Plan 2 self-review); acceptable — no dedicated edit was needed.
- `docs/design/architecture.md` created (Plan 2 Task 8 optional step — taken).

## Verification
- `npm test` → **26 tests, 26 pass, 0 fail** (`scripts/lib/catalog.test.mjs`, `assemble-env.test.mjs`, `clean-env.test.mjs`, `render-status.test.mjs`).
- `node scripts/render-status.mjs` → clean; `docs/STATUS.md` shows plan progress `84/84`, design-doc count corrected to 1.
- `node -e "…loadCatalog(process.cwd())"` → `repos.yml` valid.
- Both mermaid diagrams (README, CLAUDE.process.md) still validate.
- Landing-page multi-repo section rendered and checked once (light + dark).
- Acceptance Criteria: all met except the end-to-end 2-repo walkthrough (explicitly deferred with BRAINSTORMING §3) and automated adopter migration (deferred).

## Files Touched
- `scripts/lib/catalog.mjs` + test — `repos.yml` loader/validator
- `scripts/assemble-env.mjs` + test — workspace reconstruction
- `scripts/clean-env.mjs` + test — teardown
- `scripts/render-status.mjs` + test — PR progress, multi-plan aggregation, template-count fix
- `skills/{setup-sdlc,write-design-doc,classify-change,write-execution-plan,write-history-entry,select-next-task,close-out}/SKILL.md` — per-skill multi-repo steps
- `CLAUDE.process.md` — meta-root model, catalog, 2 DoD items
- `CLAUDE.md`, `README.md`, `site/index.html` — multi-repo docs
- `repos.yml`, `repos.example.yml`, `repos/README.md` — catalog + template
- `package.json`, `package-lock.json`, `.gitignore` — `yaml` dep, `workspace/` ignore
- `docs/design/{execution-environment,architecture}.md`, `docs/decisions/00{1,2,3,4}_*.md`
- `docs/plans/execution-environment-{1,2}.md` — marked complete
