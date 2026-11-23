---
date: 2026-11-23
priority: Medium
severity: Low
status: PARKED
source: Extracted from 05-feature-breakdown.md (2026-11-23 software-factory discussion)
---

# Feature breakdown at the feature request and plan phases

> **Binding contracts.** These are requirements, and the acceptance criteria test against them: there are two breakdown points (feature request and plan); a feature-request split always goes through the triage stop; a split leaves no umbrella file but records the decision in every slice; each plan is its own branch, PR and fresh-context execution, merged in order, leaving main working after each merge; and plans hand off through documents only. Design must honour them or amend them explicitly, with the reason recorded in the design doc. Only "Solution Direction" is non-binding.

## Problem & Context

Large features become one spec, one design and one run of work. The results:
- a long implementation;
- a PR with too many changed files to review well;
- an agent context that grows until it is token heavy and slow, with more room for error late in the run.

The kit has weak hooks for this today:
- `write-feature-request` says a large feature "is still one spec here — the plan phase splits the work".
- `write-execution-plan` allows `<name>-1.md`, `<name>-2.md` when a design "genuinely needs multiple plans". It gives no criteria for when, no ordering between plans, no isolation between their runs, and all plans still land in one branch and one PR.

The workers effort shows the cost: a 332-line spec, a 454-line design, three plans (646, 402 and 274 lines), and about 6.9k changed lines in one PR (#17). Its three plans didn't make that PR smaller, because they shared one branch.

`superpowers:subagent-driven-development` already gives each task a fresh sub-agent. What grows without limit is the orchestrating session that carries the whole run, and the PR at the end.

## Users & Personas

- **Product owner**: files a large idea and wants it to become a few pieces, each valuable on its own, that can start sooner.
- **Reviewer**: wants each PR small enough to review properly.
- **Operator**: runs several workers and wants independent slices built in parallel.
- **The agent**: plans and executes the work and needs a small, explicit context for each run.

## Scenarios

- As a product owner with a large idea, the sizing check flags it after the interview. I confirm a proposed split into three feature requests at triage, and the first one is ready to design immediately.
- As a product owner with a request that is already small, the sizing check says not to split, and nothing changes.
- As an operator with several workers, two slices with no `after` link between them are claimed and built in parallel by different workers.
- As an agent planning an approved design that touches five repos, I split it into three plans. Each runs in a fresh context with its read contract and the handoff from the plan before it, and each ends in its own PR.
- As a reviewer, I review a plan PR of a few hundred lines, not the whole effort.
- As anyone reading a slice later, its `## Triage` section tells me it was split from what, when, why, what the other slices are, and which commit holds the original text.
- **Unhappy:** the proposed slices aren't independently valuable or testable, so the person edits or merges them at triage before anything is written.
- **Unhappy:** a slice is selected before an `after` item is done. It isn't, because the queue skips it until every `after` item is `IMPLEMENTED`.
- **Unhappy:** a later slice or plan changes a contract an earlier one shipped. The handoff note records the contract, and the earlier slice gets a follow-up feature request.
- **Unhappy:** design shows the effort is bigger than triage thought. It isn't sent back to be re-split: plan breakdown handles the size inside the effort.
- **Unhappy:** over-splitting would create many tiny efforts with more overhead than work. The sizing check's minimum size and "don't split" result prevent it.
- **Unhappy:** a plan's merge would leave main broken or expose half a feature. The plan's checks require main to stay working, with unfinished parts not wired in or not reachable.

## In Scope

**Breakdown at the feature request (`write-feature-request`)**
- **A sizing check** after the interview, before the spec is written. Signals:
  - the number of acceptance criteria;
  - the number of distinct personas or scenarios;
  - the number of repos;
  - an estimate of files changed;
  - whether parts have value on their own.

  Thresholds are configurable, and the result (split or not, with the signals) is recorded in the spec. Trivial tier never splits.
- **Slicing guidance,** in order of preference:
  1. vertical slices that each deliver user value;
  2. a thin first slice that proves the path end to end;
  3. slices by repo or layer, only when there's no other way.

  Each slice has its own acceptance criteria, is testable on its own and can ship on its own. The agent proposes 2–5 slices.
- **Confirmation at the triage stop**, which already exists. In a headless worker, the proposal becomes a triage request with the slices as options.
- **No umbrella file.** The confirmed slices replace the original request in the same commit, and git keeps the original text.
- **The decision, recorded in every slice:**
  - frontmatter `split_from: <original-slug>` and `after: [<slug>, …]`;
  - a `## Triage` section with the split date, the reason, the ordered list of all slices, and the commit that holds the original text.

  Each slice's Problem & Context covers that slice: the shared "why" in a sentence or two, plus what this slice solves.
- **Queue:** `select-next-task` and `rank()` in `queue.mjs` skip a slice whose `after` items aren't all `IMPLEMENTED`. Each slice is its own claimable effort on the board.
- **STATUS.md** groups slices by `split_from`.

**Breakdown at the plan (`write-execution-plan`)**
- **A sizing check** on the approved design: tasks, files, repos and estimated context. It decides whether one plan is enough.
- **Each plan in a split has:**
  - a scope;
  - a read contract (the design sections and files to load, not the whole design);
  - the contracts it shares with the other plans;
  - its order and dependencies;
  - its own verification.
- **One branch and PR per plan** (per repo in a multi-repo effort), for example `feat/<slug>-<n>`. Plans merge in order, and plan *n+1* starts from main after plan *n* has merged. Each merge leaves main working.
- **A fresh context for each plan:** a separate headless run in a worker, or a separate sub-agent in an interactive session. Plans hand off through documents only: plan status, a short handoff note, and the merged code. No conversation context passes between them.
- **Per-plan checks:** tests green and code review on each plan PR, then the verification stage once it exists.
- **Effort-level close-out** once, after the last plan merges: architecture and data-model docs, and the flip to `IMPLEMENTED`. The feat-req advances only when every plan is `IMPLEMENTED`.
- **No human gate on a plan split.** It only reorganizes approved work, and every plan PR is reviewed.
- **Formalize** the `plan: n of m` frontmatter and the `plans:` list in the feat-req.

**Policy**
- `breakdown` settings in the Autonomy Policy:
  - feature-request breakdown: `off | propose` (always confirmed at triage);
  - plan breakdown: `off | auto`.

  With both `off`, behaviour is as today, except that multiple plans already allowed today keep working.

## Out of Scope

- Splitting one effort across several workers. Plans stay serial inside one effort and one claim (workers spec).
- Automatic re-merging of slices.
- Estimating effort in time.
- Sending an effort back from design to be re-split into feature requests.
- Using the thinking hats to propose or check splits. That request is parked.

## Acceptance Criteria

- [ ] For a request over the size thresholds, `write-feature-request` proposes 2–5 slices before writing the spec. After confirmation at triage, it writes them as separate feature requests, each with its own acceptance criteria.
- [ ] For a request under the thresholds, no split is proposed, and the sizing result is recorded in the spec.
- [ ] After a split, no file remains for the original request, and every slice has `split_from`, its `after` list, and a `## Triage` section naming the date, the reason, all slices in order and the commit with the original text.
- [ ] A slice with an `after` item that isn't `IMPLEMENTED` is not selected by `select-next-task` and not ranked by `rank()`.
- [ ] Two slices with no `after` link between them can be claimed by different workers at the same time.
- [ ] STATUS.md groups slices by `split_from`.
- [ ] A design over the plan thresholds produces multiple plans, each with a scope, a read contract, shared contracts, dependencies and its own verification.
- [ ] Each plan runs with a context containing only its read contract and the handoff from earlier plans (tested on what is passed to the run).
- [ ] Each plan ends in its own branch and PR. Plan *n+1* doesn't start until plan *n* has merged.
- [ ] Main's tests pass after each plan merges.
- [ ] Effort-level close-out runs once, after the last plan, and the feat-req becomes `IMPLEMENTED` only when every plan is.
- [ ] Sizing thresholds are configurable, and trivial tier never splits.
- [ ] With `breakdown` set to `off` for both phases, behaviour is unchanged.

## Success Metrics

- **Tokens:** median tokens per run and per effort go down, compared with efforts of similar scope before breakdown.
- **PR size:** median files changed per PR and median review time go down.

## Constraints & Dependencies

- **Dependencies:**
  - Workers and the work board (`docs/feat-req/workers.md`, branch `feat/workers-design`) for slices as claimable efforts, parallel building, and headless triage requests.
  - Isolated plan runs in workers use the roles and narrow contexts from the independent verification request. Interactive sessions can use sub-agents without them.
- **Constraints:**
  - Changes the sentence in `write-feature-request` that says a large feature stays one spec, and the "one plan per feature by default" rule and single-PR assumption in `write-execution-plan`.
  - `close-out` and the Definition of Done need a per-plan subset and an effort-level remainder.
  - The independent verification request runs `IN_REVIEW` per effort. With one PR per plan, its design must handle a review per plan PR.
  - Avoid the name `depends_on`, which `repos.yml` already uses for repos.
  - The artifact trail must not grow much (BRAINSTORMING §6). Handoff notes stay short, and slices don't copy the original spec.
  - Contract and skills stay in sync. New wording must pass the Copilot rewrite test.

## Open Questions

- What are the default size thresholds, and in which units (criteria, files, repos, tokens or a mix)?
- Should plan *n+1* be allowed to start on a stacked branch before plan *n* merges, to avoid waiting on review?
- How are contracts shared between slices built in parallel kept consistent?
- Should plans become separately claimable by different workers later?
- How does STATUS.md show progress across slices without a parent record (for example "2 of 3 done")?
- Where does the handoff note live: in the plan file, or a separate short file?

## Solution Direction

Non-binding. Slice frontmatter could look like:

```yaml
split_from: workers
after: [workers-registry]
```

with the sizing result recorded as a short `## Sizing` note in the spec. Plan frontmatter keeps `plan: 2 of 3` and adds `after: [<slug>-1]` and a `reads:` list for the read contract.

## Triage

**PARKED** (2026-11-23).

- **Reason:** the concept needs more discussion before it enters the queue. The main points to settle are in Open Questions, along with the two-point model itself (feature-request slices with no umbrella, and one PR per plan).
- **Un-park when:** that discussion has happened and its outcome is folded into this spec, then triage again.
