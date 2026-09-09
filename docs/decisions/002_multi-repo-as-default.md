# Multi-repo as the default; single-repo is N=1

## Status
Accepted

## Context
The kit was built single-repo-first. Real work spans a few to many repos. Adding multi-repo support could be a bolt-on mode or the baseline model.

## Options Considered
- **Opt-in multi-repo mode** — single-repo stays the default code path; multi-repo projects get `repos.yml`, `workspace/`, and per-repo sections in design/plan. Keeps the common one-repo case free of indirection.
- **Co-located meta-root for N=1** — a solo project keeps the kit + `docs/` inside its one code repo; only true multi-repo projects get a separate meta-root.
- **Multi-repo as the baseline** — every project has a meta-root, a `repos.yml`, and a `workspace/`. A solo project is just one catalog entry and one checkout.

## Decision
Multi-repo is the baseline. N=1 is a degenerate case of the same machinery: one `repos.yml` entry, one repo under `workspace/`, `setup-sdlc` auto-generates the entry with a single confirmation.

## Consequences
- Every skill has exactly one path model (`<key>:<repo-relative-path>`, code under `workspace/<key>/`). No `if single-repo` branches, no forked process contract.
- Solo-repo adopters carry a slightly awkward two-repo setup (meta-root + their app repo) and a small amount of per-repo ceremony in artifacts. Judged an acceptable tax for the consistency, and solo-of-many is the rarer case.
- The process trail lives at the meta-root, not inside any code repo — correct for multi-repo (the trail spans repos), a minor oddity for N=1.
- Existing single-repo adopters need a migration (move code into `workspace/<key>/`, lift `docs/` to the meta-root). Documented as steps; automated `setup-sdlc --migrate` is a follow-up.
