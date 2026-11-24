---
date: 2026-11-24
priority: Medium
severity: Low
status: DESIGNED
source: Split from feature-breakdown (original text in commit e765c89)
split_from: feature-breakdown
---

# Breakdown at the feature request phase

> **Binding contracts.** These are requirements, and the acceptance criteria test against them: the sizing check runs for every feature request; a split is always confirmed at the triage stop; a split leaves no umbrella file; every slice records the split decision; and the queue never selects a slice before its `after` items are `IMPLEMENTED`. Design must honour them or amend them explicitly, with the reason recorded in the design doc. Only "Solution Direction" is non-binding.

## Problem & Context

Large ideas are filed as one feature request and carried through the whole lifecycle as one effort: one spec, one design, one long run of work. The skill even says so: `write-feature-request` states that a large feature "is still one spec here — the plan phase splits the work".

The result is efforts that take very long, touch too many files, need a very long, token-heavy context, and can't be built in parallel. The workers effort is the example: a 332-line spec, a 454-line design, and about 6.9k changed lines in one PR (#17).

Much of that size is visible at definition time. An idea often contains parts that each deliver value on their own and could be designed, built and shipped separately, and by different workers in parallel.

## Users & Personas

- **Product owner**: files a large idea and wants it to become a few pieces that each deliver value and can start sooner.
- **Operator**: runs several workers and wants independent pieces built in parallel.
- **Reviewer**: benefits from smaller efforts and therefore smaller PRs.

## Scenarios

- As a product owner with a large idea, the sizing check flags it after the interview. I confirm a proposed split into three feature requests at triage, and the first one is ready to design immediately.
- As a product owner with a request that is already small, the sizing check says not to split, and nothing changes.
- As an operator with several workers, two slices with no `after` link between them are claimed and built in parallel by different workers.
- As anyone reading a slice later, its `## Triage` section tells me it was split from what, when, why, what the other slices are, and which commit holds the original text.
- As a product owner, I see the slices grouped together in STATUS.md.
- **Unhappy:** the proposed slices aren't independently valuable or testable, so I edit or merge them at triage before anything is written.
- **Unhappy:** a slice is selected before an `after` item is done. It isn't, because the queue skips it until every `after` item is `IMPLEMENTED`.
- **Unhappy:** a later slice changes a contract an earlier slice shipped, so the earlier slice gets a follow-up feature request.
- **Unhappy:** over-splitting would create many tiny efforts with more overhead than work. The sizing check's minimum size and "don't split" result prevent it.
- As a product owner, I never have to ask for a size check. It runs on every new request, and the spec records its result.
- As a product owner, I have an accepted request filed before this feature existed. I invoke the size check on it explicitly, and confirm or reject the split it proposes.
- **Unhappy:** in a headless worker, the proposal becomes a triage request with the slices as options, and nothing is split until a person answers.

## In Scope

- **A sizing check** in `write-feature-request`, after the interview and before the spec is written. Signals:
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
- **Always on.** The sizing check runs for every new feature request, with no setting to turn it off. Its result is always recorded in the spec, whether or not it proposes a split. A split is always confirmed at triage.
- **Re-checking on request.** The check doesn't run again on its own once a request is accepted. A person can run it explicitly on an existing request, for example on one filed before this feature existed. Any proposed split goes through the same triage confirmation and leaves the same record.
- **Removing the sentence** in `write-feature-request` that says a large feature stays one spec.

## Out of Scope

- Breakdown at the plan phase. That is a separate request (`docs/feat-req/plan-breakdown.md`).
- Sending an effort back from design to be re-split into feature requests.
- Automatic re-merging of slices.
- Estimating effort in time.
- Using the thinking hats to propose or check splits. That request is parked.

## Acceptance Criteria

- [ ] For a request over the size thresholds, `write-feature-request` proposes 2–5 slices before writing the spec. After confirmation at triage, it writes them as separate feature requests, each with its own acceptance criteria.
- [ ] For a request under the thresholds, no split is proposed, and the sizing result is recorded in the spec.
- [ ] After a split, no file remains for the original request, and every slice has `split_from`, its `after` list, and a `## Triage` section naming the date, the reason and all slices in order. A re-check split also names the commit with the original text; a split at intake says "split at intake" (amended at design approval, 2026-11-24).
- [ ] A slice with an `after` item that isn't `IMPLEMENTED` is not selected by `select-next-task` and not ranked by `rank()`.
- [ ] Two slices with no `after` link between them can be claimed by different workers at the same time.
- [ ] STATUS.md groups slices by `split_from`.
- [ ] In a headless run, a proposed split is shown in the triage gate's Context, and nothing is split until a person does it with the explicit re-check (amended at design approval, 2026-11-24).
- [ ] Sizing thresholds are configurable, and trivial tier never splits.
- [ ] The sizing check runs for every new feature request, and no setting disables it.
- [ ] The check never runs on its own on an already-accepted request. When a person invokes it on one, a confirmed split produces the same slices and records as a split at intake.

## Success Metrics

- **PR size:** median files changed per PR and median review time go down.
- **Tokens:** median tokens per effort go down, compared with efforts of similar scope before breakdown.

## Constraints & Dependencies

- **Dependencies:** workers and the work board (`docs/feat-req/workers.md`, merged) for slices as claimable efforts, parallel building, and headless triage requests.
- **Constraints:**
  - Avoid the name `depends_on`, which `repos.yml` already uses for repos.
  - The artifact trail must not grow much (BRAINSTORMING §6). Slices don't copy the original spec.
  - Contract and skills stay in sync. New wording must pass the Copilot rewrite test.

## Open Questions

- What are the default size thresholds, and in which units (criteria, files, repos or a mix)?
- How are contracts shared between slices built in parallel kept consistent?
- How does STATUS.md show progress across slices without a parent record (for example "2 of 3 done")?
- How is the check invoked on an existing request: a mode of `write-feature-request`, or a separate command?

## Solution Direction

Non-binding. Slice frontmatter could look like:

```yaml
split_from: workers
after: [workers-registry]
```

with the sizing result recorded as a short `## Sizing` note in the spec.

## Triage

**ACCEPTED** (2026-11-24). Split from `feature-breakdown` on 2026-11-24.

- **Reason for the split:** breakdown at the feature request and breakdown at the plan are separate concerns. They change different skills, deliver value independently, and neither depends on the other.
- **Slices:** `feature-request-breakdown` (this one), `plan-breakdown`. There is no order between them.
- **Original text:** commit `e765c89`, `docs/feat-req/feature-breakdown.md`.

## Decisions

- 2026-11-24 · design approved (`docs/design/feature-request-breakdown.md`): size thresholds lowered to 12 criteria, 3 personas, 2 repos, 30 files; two acceptance criteria amended (original-text commit applies to re-check splits only; headless shows slices in the triage gate's Context).
