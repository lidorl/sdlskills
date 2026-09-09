# Meta-root repo with a git-ignored `workspace/` of plain clones

## Status
Accepted

## Context
Multi-repo work needs the code repos an effort touches to be present on disk, side by side, while the kit's process trail (feat-req, design, plans, history) needs a stable home. How should the repos be brought in and versioned relative to the kit?

## Options Considered
- **Git submodules** — `workspace/<key>` as submodules of the meta-root. Version-pinned, reproducible. But adding/removing a submodule per effort is heavy ceremony, and pinning fights the model where the repo set is provisional and evolves during Design.
- **Per-effort checkout dirs** — `workspace/<effort>/<key>/`. Multiple efforts assembled at once without collision. But under the single-worker assumption only one effort is ever in flight, so this mostly duplicates checkouts and wastes disk.
- **Single git-ignored `workspace/` of plain clones** — `workspace/<key>/`, each an independent `git clone` with its own history and remote. A script assembles the set an effort needs and a `.current-effort` marker guards against acting on a stale set.

## Decision
Single git-ignored `workspace/` of plain clones. The meta-root is its own git repo holding the kit + `repos.yml` + `docs/`; `workspace/` is in `.gitignore`. `assemble-env.mjs` (idempotent, shallow) reconstructs the set from a design doc's `repos:` list; `workspace/.current-effort` records which effort is assembled.

## Consequences
- No submodule bookkeeping; the repo set can change freely during Design.
- Reproducing an old effort's exact state is not automatic — you re-clone current `main` and the effort branch, not a pinned SHA. Acceptable: the PRs and history entry record what actually shipped.
- `.current-effort` is a single-worker shortcut. Parallel efforts (see `docs/kit-open-items.md`) will need per-effort dirs — that's the documented upgrade path, and it composes with this decision rather than replacing it.
- Disk cost per effort is one shallow clone per repo; mitigated by reuse of existing checkouts.
