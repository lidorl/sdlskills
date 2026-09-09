---
date: 2026-09-09
priority: High
severity: Medium
status: ACCEPTED
source: Extracted from docs/design/execution-environment.md (Open Items, at close-out)
---

# End-to-end validation of the multi-repo execution environment

## Problem & Context

The execution-environment feature was implemented and unit-tested (26 tests over `catalog.mjs`, `assemble-env.mjs`, `clean-env.mjs`, `render-status.mjs`), but nothing exercises the whole flow across real repositories: catalog → design resolves the repo set → `assemble-env` → per-repo `classify-change` → plan with `## Pull Requests` → per-repo PRs → `close-out` verifies merges → `status: IMPLEMENTED`. Until that runs once, "it works" is an inference from the parts.

## Users & Personas

- Kit maintainers — need confidence the lifecycle holds across repos before recommending multi-repo adoption.
- Adopters — need a worked reference for what "using it well" looks like.

## Scenarios

- As a maintainer, I run a scripted end-to-end test that drives one small cross-repo feature through every phase and asserts the artifacts are well-formed and both PRs are referenced.
- As an adopter, I read a two-repo example (`backend` + `frontend`) and follow a guided feature to learn the flow.

## In Scope

- A minimal two-repo example system (or fixtures) — small enough to read in a sitting.
- An automated check that runs the lifecycle (or a faithful simulation) and validates: design-doc `repos:` + `## Repositories in Scope`; plan `## Repositories` + `## Pull Requests` anchors parse; `assemble-env` reconstructs the set; `close-out`'s `gh` verification gates correctly; `render-status` shows per-effort PR progress.
- Wiring it into CI.

## Out of Scope

- The broader "example project" ambition in `BRAINSTORMING.md` §3 beyond what validates this feature.
- Testing non-GitHub hosts.

## Acceptance Criteria

- [ ] A two-repo fixture exists and is documented.
- [ ] An automated test drives feat-req → `IMPLEMENTED` for one cross-repo change and asserts artifact well-formedness + PR references.
- [ ] The test runs in CI and fails loudly on a broken anchor or a skipped phase.
- [ ] A short guided walkthrough doc points an adopter through the same feature by hand.

## Success Metrics

- One command reproduces a full green multi-repo lifecycle run.

## Constraints & Dependencies

- **Dependencies:** the shipped execution-environment feature; `gh` (or a stub) for the PR-verification step.
- **Related:** `BRAINSTORMING.md` §3 (example project), `docs/design/execution-environment.md`.

## Open Questions

- [ ] Real GitHub repos vs. local bare-repo fixtures + a `gh` stub for CI.
- [ ] How much of `close-out`'s agent-driven steps can be asserted vs. simulated.

## Solution Direction

Local bare-repo fixtures + a thin `gh` shim is likely enough for CI and avoids network flakiness; a separate opt-in "real GitHub" run can live outside CI. Non-binding.
