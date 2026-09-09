---
date: 2026-09-09
priority: High
severity: Medium
status: PLANNED
source: Extracted from BRAINSTORMING.md §1 (brainstormed 2026-09-09)
plans:
  - docs/plans/execution-environment-1.md
  - docs/plans/execution-environment-2.md
---

# Multi-repo execution environment

## Problem & Context

The kit assumes all work happens in one repository. Real work does not — a feature or product request, and especially an architecture change, usually touches anywhere from a few to many repositories. Today there is no way to record which repo does what, assemble the subset a given effort needs, reference repos from design docs and plans, or coordinate a change that spans several repos through the lifecycle (branches, PRs, merge order, a combined "done" state).

## Users & Personas

- **Multi-repo adopter** — the common case. Works across several repos; needs the lifecycle to span them coherently.
- **The agent** — executes the lifecycle; needs to know which repos an effort involves and to never act on the wrong one.
- **Solo-repo adopter** — the degenerate N=1 case; must not pay meaningful overhead for a capability they don't use.

## Scenarios

- As an adopter, I run `/setup-sdlc` once and describe my repositories, so the agent has a catalog of which repo does what.
- As an adopter, I file a feature request; during Design the agent determines which repos are involved, assembles them into the workspace, and records why each is in scope.
- As the agent, I execute a plan that changes three repos: I branch `feat/<effort>` in each, open a PR per repo when its work passes, and Close-out confirms all three merged before marking the effort implemented.
- As an adopter, I pick up a half-finished cross-repo effort and the workspace reconstructs itself from the approved design doc.
- As a solo-repo adopter, setup is a single confirmation and the per-repo sections stay out of my artifacts.
- **Unhappy path:** the agent can't tell whether a repo belongs to an effort → it reads `repos/<key>.md` → still unclear → it asks me.
- **Unhappy path:** a PR is merged out-of-band → Close-out's live check reports the true state rather than trusting the plan's table.

## In Scope

- Meta-root structure: adopter's private git repo holding kit files + catalog + `docs/` trail; `workspace/` subfolder (git-ignored) for per-effort checkouts.
- Repository catalog: `repos.yml` (structured index) + `repos/<key>.md` (deeper notes) + a written selection procedure.
- `/setup-sdlc` gains a catalog-building interview step (v1); N=1 auto-generates the single entry from repo URL + README.
- Repo binding as a **Design output**: design-doc frontmatter `repos: [...]` + a `## Repositories in Scope` section, locked at approval.
- `/classify-change` runs **per repo**; effort tier = highest across its repos; per-repo verdict recorded in the plan.
- Plan gains anchored `## Repositories` (role + tier per repo) and `## Pull Requests` (`key │ branch │ PR URL │ state`) sections. Merge order stays in the design doc's Rollout & Migration section.
- Scripts: `assemble-env <effort>` (idempotent; shallow-clone, checkout `feat/<effort>`, pull; `.current-effort` marker) and `clean-env`.
- Development phase: branch `feat/<effort>` across all effort repos up front; PR per repo at the end of that repo's work.
- Close-out: verify every effort repo has a merged PR via `gh pr view` before flipping `status: IMPLEMENTED`; new Definition-of-Done item.
- Path-key convention for all file references in artifacts: `api:src/offers/offers.service.ts`.
- N=1 handling: equivalent artifacts to today's, minus nothing essential.
- Doc updates: `CLAUDE.process.md`, and the skills `setup-sdlc`, `write-design-doc`, `write-execution-plan`, `classify-change`, `write-history-entry`, `select-next-task`, `close-out`; `render-status.mjs`; README + landing page.

## Out of Scope

- Parallel agents / multiple simultaneous efforts (tracked in `docs/kit-open-items.md`; per-effort `workspace/` dirs are the future upgrade).
- Org-wide catalog auto-draft from READMEs / manifests (follow-up — "option D" from the brainstorm).
- A repo-level documentation standard (BRAINSTORMING.md §5 — feeds this, but separate work).
- Cross-repo language tooling / IDE ergonomics (not the kit's concern).
- Meta-VCS tooling — bare `git` plus the shared branch-name convention only.
- Git submodules.
- Custom phases / extensibility (BRAINSTORMING.md §4).
- Non-GitHub hosts (GitLab, Bitbucket) — v1 assumes git + GitHub + `gh`.

## Acceptance Criteria

- [ ] `/setup-sdlc` produces a schema-valid `repos.yml` via interview; N=1 path auto-generates the single entry from URL + README with one confirmation.
- [ ] Design phase resolves and records the repo set; the design doc has `repos:` frontmatter and a populated `## Repositories in Scope` section; the list is fixed at approval.
- [ ] `assemble-env <effort>` is idempotent, shallow-clones missing repos, checks out `feat/<effort>` in each, and detects a `workspace/.current-effort` mismatch and reassembles.
- [ ] `/classify-change` emits a per-repo verdict; the plan's `## Repositories` section records each repo's role and tier.
- [ ] The plan has anchored `## Repositories` and `## Pull Requests` sections that `render-status.mjs` can parse.
- [ ] `/close-out` blocks `status: IMPLEMENTED` until every effort repo has a merged PR, verified live via `gh`.
- [ ] `render-status.mjs` shows per-effort PR progress (e.g. `3/5 merged`) in `docs/STATUS.md`.
- [ ] Path-key references (`key:path`) are used consistently across design docs, plans, and history entries.
- [ ] The N=1 flow produces artifacts equivalent to the current single-repo flow.
- [ ] `CLAUDE.process.md`, all affected skills, the README, and the landing page are updated; the 2-repo example (BRAINSTORMING.md §3) is referenced as the walkthrough.

## Success Metrics

- A cross-repo feature goes request → implemented without the agent acting on the wrong repo and without a half-merged effort going undetected.
- Solo-repo adoption effort is unchanged (setup in a few minutes; artifacts unchanged).

## Constraints & Dependencies

- **Dependencies:** `gh` CLI, authenticated, for all PR operations. Git + GitHub. The single-worker assumption from `docs/kit-open-items.md` holds.
- **Interacts with:** the parallel-agents open item; BRAINSTORMING.md §5 (repo-level docs, feeds the catalog); BRAINSTORMING.md §3 (example project — the test vehicle for this).
- **Constraints:** must not regress the single-repo experience; skills are symlinked from the kit, so per-project state (catalog, `workspace/`) lives at the meta-root only.

## Open Questions

Tackle during Design / Plan:

- [ ] Confirm the `workspace/` name is final.
- [ ] Exact `repos.yml` schema — field names, required vs. optional, how `depends_on` and `keywords` are used by the selection procedure.
- [ ] `assemble-env` / `clean-env` — implementation language (`.mjs`, matching `render-status.mjs`?), location, and how they handle auth for private repos.
- [ ] Branch naming when the feat-req name is long or collides across efforts.
- [ ] How merge order is expressed in the Rollout & Migration section — an ordered list of repo keys?
- [ ] N=1: does the meta-root have to be a separate repo, or may the kit files + `docs/` live inside the single code repo? (Leaning: accept the separation; revisit.)
- [ ] History entry structure for a multi-repo change — per-repo subsections, or one narrative with repo tags?
- [ ] What happens to `workspace/` checkouts after Close-out — auto-clean, or leave for follow-up work?
- [ ] Guidance for editor / tooling ergonomics when working from the meta-root.
- [ ] A repo that surfaces mid-Development but isn't in the approved `repos:` list — reopen Design, or add it with a recorded note?
- [ ] Can a single repo be `hotfix` tier within an otherwise-standard effort?
- [ ] Interaction with `superpowers:executing-plans` checkpoints when execution spans repos.

## Solution Direction

*Non-binding — the shape agreed during the 2026-09-09 brainstorm. Design confirms or revises.*

- **Meta-root** = adopter's private git repo: `CLAUDE.process.md`, skills, autonomy policy, `repos.yml`, `repos/`, `docs/`. `workspace/` is git-ignored; each checkout under it keeps its own git history.
- **Catalog.** `repos.yml` entries: `key`, `url`, `default_branch`, `domain`, `summary` (paragraph), `responsibilities` (list), `depends_on` (keys), `keywords`, `notes` (flag). `repos/<key>.md` for depth. Selection procedure: match against `summary` / `responsibilities` → clear yes/no; ambiguous → read `repos/<key>.md`; still unclear → ask the user.
- **Repo binding is a Design output**, not intake. Design begins with a provisional working set, converges through brainstorming, locks at approval into `repos:` frontmatter + `## Repositories in Scope`. Plan and `classify-change` read only the approved list.
- **Tiers.** Effort tier = max across repos; per-repo work scales to each repo's own `classify-change` verdict, recorded in the plan.
- **Coordination lives in the plan** — no new document. `## Repositories` (role + tier) and `## Pull Requests` (`key │ branch │ PR URL │ state`). `close-out` verifies live via `gh`, never trusting the table.
- **Operational.** `assemble-env <effort>` idempotent, shallow, checks out `feat/<effort>`, `.current-effort` marker, reassembles on mismatch. Development branches all effort repos up front; PRs per repo at the end. Agent always `cd`s into `workspace/<key>/` for stack commands.
- **N=1** is the same machinery with one catalog entry and one repo.

## Related Docs

- `BRAINSTORMING.md` §1 (source), §3 (example project / test vehicle), §5 (repo-level docs)
- `docs/kit-open-items.md` (parallel agents — related axis)
