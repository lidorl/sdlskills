---
date: 2026-11-24
priority: Medium
severity: Low
status: ACCEPTED
source: Split from feature-breakdown (original text in commit e765c89)
split_from: feature-breakdown
---

# Breakdown at the plan phase

> **Binding contracts.** These are requirements, and the acceptance criteria test against them: each plan in a split is its own branch, PR and fresh-context execution; plans merge in order, and main keeps working after each merge; plans hand off through documents only; and the feat-req becomes `IMPLEMENTED` only after every plan is. Design must honour them or amend them explicitly, with the reason recorded in the design doc. Only "Solution Direction" is non-binding.

## Problem & Context

Some size only shows up in the design. Once a design is approved, `write-execution-plan` allows `<name>-1.md`, `<name>-2.md` when a design "genuinely needs multiple plans". But it gives:
- no criteria for when to split;
- no ordering between plans;
- no isolation between their runs.

All plans still land in one branch and one PR.

The workers effort shows the cost. Its three plans (646, 402 and 274 lines) shared one branch, and the result was about 6.9k changed lines in one PR (#17). Splitting the plan didn't make the PR smaller.

`superpowers:subagent-driven-development` already gives each task a fresh sub-agent. What grows without limit is the orchestrating session that carries the whole run, and the PR at the end.

## Users & Personas

- **Reviewer**: wants each PR small enough to review properly.
- **The agent**: plans and executes the work and needs a small, explicit context for each run.
- **Operator**: wants long efforts to make steady, mergeable progress, not one huge run that fails late.

## Scenarios

- As an agent planning an approved design that touches five repos, I split it into three plans. Each runs in a fresh context with its read contract and the handoff from the plan before it, and each ends in its own PR.
- As an agent planning a small design, the sizing check says one plan is enough, and nothing changes.
- As a reviewer, I review a plan PR of a few hundred lines, not the whole effort.
- As an operator, plan 1 merges and main is green, while plan 2 starts from that main in a fresh context.
- **Unhappy:** design shows the effort is bigger than triage thought. It isn't sent back to be re-split into feature requests; plan breakdown handles the size inside the effort.
- **Unhappy:** a later plan needs to change a contract an earlier plan shipped. The handoff note records the contract, and the change is made explicitly in the later plan, with the reason.
- **Unhappy:** a plan's merge would leave main broken or expose half a feature. The plan's checks require main to stay working, with unfinished parts not wired in or not reachable.
- **Unhappy:** a worker takes over an effort between plans. It resumes from the first plan not yet `IMPLEMENTED`, using only the documents.

## In Scope

- **A sizing check** in `write-execution-plan` on the approved design: tasks, files, repos and estimated context. It decides whether one plan is enough. Thresholds are configurable, and the result is recorded.
- **Each plan in a split has:**
  - a scope;
  - a read contract (the design sections and files to load, not the whole design);
  - the contracts it shares with the other plans;
  - its order and dependencies;
  - its own verification.
- **One branch and PR per plan** (per repo in a multi-repo effort), for example `feat/<slug>-<n>`. Plans merge in order, and plan *n+1* starts from main after plan *n* has merged. Each merge leaves main working.
- **A fresh context for each plan:** a separate headless run in a worker, or a separate sub-agent in an interactive session. Plans hand off through documents only: plan status, a short handoff note, and the merged code. No conversation context passes between them.
- **Per-plan checks:** tests green and code review on each plan PR, then the verification stage once it exists.
- **Effort-level close-out** once, after the last plan merges: architecture and data-model docs, and the flip to `IMPLEMENTED`. `close-out` and the Definition of Done get a per-plan subset and an effort-level remainder.
- **No human gate on a plan split.** It only reorganizes approved work, and every plan PR is reviewed.
- **Formalize** the `plan: n of m` frontmatter and the `plans:` list in the feat-req.
- **Policy:** `breakdown.plan: off | auto` in the Autonomy Policy. With `off`, behaviour is as today, including the multiple plans already allowed.
- **Replacing** the "one plan per feature by default" rule and the single-PR assumption in `write-execution-plan`.

## Out of Scope

- Breakdown at the feature request phase. That is a separate request (`docs/feat-req/feature-request-breakdown.md`).
- Splitting one effort across several workers. Plans stay serial inside one effort and one claim (workers spec).
- Sending an effort back from design to be re-split into feature requests.
- Estimating effort in time.

## Acceptance Criteria

- [ ] A design over the plan thresholds produces multiple plans, each with a scope, a read contract, shared contracts, dependencies and its own verification.
- [ ] A design under the thresholds produces one plan, and the sizing result is recorded.
- [ ] Each plan runs with a context containing only its read contract and the handoff from earlier plans (tested on what is passed to the run).
- [ ] Each plan ends in its own branch and PR. Plan *n+1* doesn't start until plan *n* has merged.
- [ ] Main's tests pass after each plan merges.
- [ ] A takeover between plans resumes from the first plan not yet `IMPLEMENTED`.
- [ ] Effort-level close-out runs once, after the last plan, and the feat-req becomes `IMPLEMENTED` only when every plan is.
- [ ] Sizing thresholds are configurable, and trivial tier never splits.
- [ ] With `breakdown.plan: off`, behaviour is unchanged.

## Success Metrics

- **Tokens:** median tokens per run go down, compared with efforts of similar scope before breakdown.
- **PR size:** median files changed per PR and median review time go down.

## Constraints & Dependencies

- **Dependencies:**
  - Isolated plan runs in workers use the roles and narrow contexts from the independent verification request. Interactive sessions can use sub-agents without them.
  - Workers and the work board (`docs/feat-req/workers.md`, merged) for takeovers between plans.
- **Constraints:**
  - The independent verification request runs `IN_REVIEW` per effort. With one PR per plan, its design must handle a review per plan PR.
  - The artifact trail must not grow much (BRAINSTORMING §6). Handoff notes stay short.
  - Contract and skills stay in sync. New wording must pass the Copilot rewrite test.

## Open Questions

- What are the default plan-size thresholds, and in which units (tasks, files, repos, tokens or a mix)?
- Should plan *n+1* be allowed to start on a stacked branch before plan *n* merges, to avoid waiting on review?
- Should plans become separately claimable by different workers later?
- Where does the handoff note live: in the plan file, or a separate short file?
- What is the effort's status between plans: does it stay `IN_PROGRESS` while plan PRs wait for review?

## Solution Direction

Non-binding. Plan frontmatter keeps `plan: 2 of 3` and adds `after: [<slug>-1]` and a `reads:` list for the read contract. The handoff note could be a short `## Handoff` section at the end of each plan file.

## Triage

**ACCEPTED** (2026-11-24). Split from `feature-breakdown` on 2026-11-24.

- **Reason for the split:** breakdown at the feature request and breakdown at the plan are separate concerns. They change different skills, deliver value independently, and neither depends on the other.
- **Slices:** `feature-request-breakdown`, `plan-breakdown` (this one). There is no order between them.
- **Original text:** commit `e765c89`, `docs/feat-req/feature-breakdown.md`.
