# Cross-repo coordination lives in the execution plan, not a separate manifest

## Status
Accepted

## Context
An effort spanning several repos needs per-repo branch names, PR URLs, merge state, and a merge order tracked somewhere, and `close-out` needs to check "is every repo's PR merged?" before marking the effort done.

## Options Considered
- **A dedicated change-set manifest** — one file per effort tracking each repo's branch, PR, and merge state. Clean separation of plan (intent) from state (reality); `close-out` reads it.
- **A meta-VCS tool** (`meta`, `mu-repo`, custom) — run git ops across all effort repos at once. Powerful, but couples the kit to a third-party tool and is more than a single-worker kit needs.
- **Fold it into the plan** — the plan already breaks work down per repo and is already a living document during execution (checkboxes get ticked). Add a `## Repositories` section (role + tier) and a `## Pull Requests` table (`key │ branch │ PR │ state`); keep merge order in the design doc's Rollout section.

## Decision
Fold it into the plan. No new per-effort document. `close-out` verifies PR state **live** via `gh pr view` rather than trusting the plan's table — the table is a convenience cache, GitHub is the source of truth.

## Consequences
- No artifact proliferation — consistent with the kit's stance against ceremony.
- The plan now carries mutable state (PR merge status) that can drift if a PR is merged out-of-band. Mitigated by `close-out`'s live check and by `render-status.mjs` treating the table as unverified.
- `## Pull Requests` and `## Repositories` become parseable anchors that `render-status.mjs` and `select-next-task` depend on — a format contract, like the other section anchors in the kit.
- No dependency on any cross-repo git tool; `git` + a shared `feat/<slug>` branch name is the whole mechanism.
