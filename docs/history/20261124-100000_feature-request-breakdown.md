---
date: 2026-11-24
tier: standard
feat_req: docs/feat-req/feature-request-breakdown.md
plan: docs/plans/feature-request-breakdown.md
repos: [sdlskills]
---

# Feature request breakdown: walk-through and verification

## Per-Repo Summary
| key | tier | branch | PR | what changed |
|---|---|---|---|---|
| sdlskills | standard | feat/feature-request-breakdown | - | size check, slicing, split records and re-check in `write-feature-request`; `after` blocks `claim`/`rank()`/`sdlc next`; `## Splits` in STATUS.md; Breakdown thresholds in `CLAUDE.process.md` |

## Deviations
- **The walk-throughs were simulated.** No human was available, so one agent played both roles: it followed `skills/write-feature-request/SKILL.md` literally and also gave the scripted user answers. They show the skill text and the scripts produce the expected files; they do not show how a real user reacts to the proposal or how reliably a model runs the interview. Walk-throughs (a)-(c) were run in a scratch clone of the repo, (d) in a scratch board-mode meta-root (bare remote plus clone). Nothing in the real repo was touched.

## Discoveries
Walk-through results, each against the acceptance criterion it exercises:

- **(a) No split.** A 4-criterion, 1-persona, 1-repo idea ("copy-link button") stayed whole; its spec carries `## Sizing`: `2026-11-24: 4 criteria, 1 personas, 1 repo(s), ~4 files; independent parts: none → no split`. Pass for "For a request under the thresholds, no split is proposed, and the sizing result is recorded in the spec."
- **(b) Split at intake.** "Team notifications" with 15 criteria and three independent parts (email digests, Slack alerts, in-app inbox) exceeds `max_criteria` 12. The accepted split produced three files and none for `team-notifications`. `email-digests` and `in-app-inbox` have no `after`; `slack-alerts` has `after: [email-digests]`. Every file has `split_from: team-notifications` and a `## Triage` with the date, the reason, all slices in order, and `Original text: split at intake.`. `in-app-inbox` is `status: PARKED`, the other two `ACCEPTED`. `render-status` printed `### team-notifications — 0 of 3 implemented` with the three rows, and `slack-alerts` shows `Blocked by: email-digests (ACCEPTED)`. Pass for "no file remains for the original request, and every slice has `split_from`, its `after` list, and a `## Triage` section ... a split at intake says 'split at intake'" and "STATUS.md groups slices by `split_from`". Parking one slice left the others ACCEPTED, as the skill says. The repo's own `feature-breakdown` split also rendered, with its 0 of 2 count.
- **(c) Re-check split.** An ACCEPTED, committed `reporting-suite` (14 criteria: 6 scheduling, 6 CSV export, 2 dashboards) was re-checked. The dashboards part had 2 criteria, below `min_slice_criteria` 3, so it was merged into exports and the result was two slices, `report-scheduling` (6) and `report-exports` (8). `git log -1 --format=%h -- docs/feat-req/reporting-suite.md` gave `9023849`; both slices record `Original text: commit 9023849, docs/feat-req/reporting-suite.md.`, set `split_from: reporting-suite`, and the original was `git rm`'d in the same commit as the two slices. `git show 9023849:docs/feat-req/reporting-suite.md` recovers the text. Pass for "The check never runs on its own on an already-accepted request. When a person invokes it on one, a confirmed split produces the same slices and records as a split at intake" and "A re-check split also names the commit with the original text".
- **(d) Refusal.** A board-mode meta-root had an ACCEPTED `held` with `claimed_by: someone-else` and fresh `claimed_at`/`renewed_at`. After `git pull`, `node scripts/sdlc.mjs status --json` listed it under `inFlight` as `{"slug":"held","status":"ACCEPTED","claimant":"someone-else","stale":false}`. The skill's precondition ("no live claim held by someone else") fails on that, so the skill text leads to stopping and naming `someone-else`. The refusal was not executed: no skill run stopped anything. What was executed is the `git pull` and `status --json` precondition command, and what was read is the skill text that says to stop. So (d) is partial: command output observed, stop behaviour read, not observed. No listed acceptance criterion covers refusal on a foreign claim; the nearest, "The check never runs on its own on an already-accepted request...", only concerns invocation. (d) supports no criterion directly; it is evidence for the Re-check mode precondition in the skill and for the `awaiting` finding below.
- **`awaiting` is not a field in `status --json`.** For a second effort `waiting` with `awaiting: <id>` and an open request file, and no claim, the JSON has no `awaiting` anywhere: `inFlight` lists only claimed efforts (`slug`, `status`, `claimant`, `claimAgeMs`, `stale`), and `waiting` is absent from it. The only trace is `inbox.owner[0].fm.effort == "waiting"` for the open request. So the skill's "no open `awaiting`" check can only be done by matching `inbox[].fm.effort` to the slug, which the skill does not say.

Ambiguity findings in `skills/write-feature-request/SKILL.md` (the skill was not changed):
1. Re-check precondition: "no open `awaiting`" does not say where `status --json` shows it. See above; it needs a sentence naming `inbox` matching on `fm.effort`, or `status --json` should expose `awaiting` per effort.
2. Re-check precondition: `inFlight` also lists the user's own claims, and a stale foreign claim has `stale: true`. The text says "no live claim held by someone else", but not whether the user's own claim blocks the re-check or whether a stale claim counts as live.
3. Re-check split: the Sizing line template for a confirmed split says "each slice's line names the split", while re-check mode shows only the no-split line with `re-checked:`. I wrote `re-checked: ... → split into a, b` on the slices. Whether slices also carry the original's earlier Sizing lines is not stated.
4. The `## Sizing` template prints "<n> personas" and "<n> repo(s)", which reads "1 personas" for one persona. Cosmetic.
5. The merge rule ("Merge a smaller slice into a neighbour") does not say which neighbour or how to choose when several fit; I merged the 2-criterion dashboards part into the exports slice because it was the closer topic.
6. The Triage template's park condition has no named field; PARKED says "add a `## Triage` section with the reason and any condition", while slice records fix the bullet list. I added an extra bullet for the un-parking condition.
7. Slice slugs: "`split_from` must not name an existing feat-req file" at intake, but nothing says to check that the slices' own slugs are free; I checked by eye.
8. Frontmatter parse: `render-status`'s parser reads `after: [a]` flow lists only; a block list would be silently ignored. The skill's example uses the flow form, so it is fine as written.

### Evidence for walk-through (b)

Reproduced in a fresh scratch clone at the walk-through commit (the original `reporting-suite` file from (c) was deleted there so only (b)'s files remain). Output pasted verbatim from `node scripts/render-status.mjs` and `cat docs/feat-req/slack-alerts.md`. The raw output of the first run was not preserved; this is a re-run of the same steps.

`## Splits` block of STATUS.md (the repo's own `feature-breakdown` block precedes it and is omitted):

```
### team-notifications — 0 of 3 implemented
| Slice | Status | After | Blocked by |
|---|---|---|---|
| email-digests | ACCEPTED |  |  |
| in-app-inbox | PARKED |  |  |
| slack-alerts | ACCEPTED | email-digests | email-digests (ACCEPTED) |
```

`docs/feat-req/slack-alerts.md` frontmatter and `## Triage`:

```
---
date: 2026-11-24
priority: Medium
severity: Low
status: ACCEPTED
source: User request
split_from: team-notifications
after: [email-digests]
---
...
## Triage
**ACCEPTED** (2026-11-24). Split from `team-notifications` on 2026-11-24.
- **Reason for the split:** 15 criteria exceed max_criteria 12 and the idea has three independent parts.
- **Slices:** `email-digests`, `slack-alerts` (after `email-digests`), `in-app-inbox`
- **Original text:** split at intake.
```

The slice files were written by the scripted agent following the skill's templates, so this shows the template and `render-status` agree; it does not show that a model produces these files unprompted. Walk-throughs (a) and (c) output was likewise not preserved verbatim; only the descriptions above stand for them.

## Decisions
- Scripted user answers for (b): accept the split, accept `email-digests` and `slack-alerts`, park `in-app-inbox`, with `slack-alerts` after `email-digests` so the blocked marker is exercised.
- Not done here: the acceptance criteria on `after` blocking, parallel claims and headless handling are covered by the Task 2-5 tests and edits, not by these walk-throughs. The headless rule (show the proposal in the `triage` gate Context, never split) was read in the skill text only, not run.

## Step Status
- Walk-throughs (a), (b), (c), (d): done.
- Full `npm test`: done (see Verification).
- This history entry: done.

## Verification
`npm test`: tests 557, pass 557, fail 0, skipped 0 (exit 0), run in the real repo on the branch.

Acceptance criteria against the walk-throughs, by criterion text. "Observed" means a file or output was produced and inspected; "read" means only the skill or script text was read.

- "For a request over the size thresholds, `write-feature-request` proposes 2-5 slices before writing the spec...": files produced in (b) and (c) (observed); the proposal-before-writing ordering is read from the skill text, not observed, because one agent played both roles.
- "For a request under the thresholds, no split is proposed, and the sizing result is recorded in the spec": (a) observed.
- "After a split, no file remains for the original request, and every slice has `split_from`, its `after` list, and a `## Triage` section...": (b) and (c) observed.
- "A slice with an `after` item that isn't `IMPLEMENTED` is not selected by `select-next-task` and not ranked by `rank()`": not exercised here; covered by Task 2-5 tests (`select-next-task` text read only).
- "Two slices with no `after` link between them can be claimed by different workers at the same time": not exercised here; Task 2-5 tests.
- "STATUS.md groups slices by `split_from`": (b) observed, output pasted above.
- "In a headless run, a proposed split is shown in the triage gate's Context, and nothing is split until a person does it with the explicit re-check": read from the skill text only; not run, not observed.
- "Sizing thresholds are configurable, and trivial tier never splits": not exercised; read from the Breakdown section of `CLAUDE.process.md` and the skill text.
- "The sizing check runs for every new feature request, and no setting disables it": partly exercised. (a) and (b) each ran the check and recorded a result (observed), but only two requests, both played by the same agent; "no setting disables it" is read from the skill and `CLAUDE.process.md` ("The size check always runs"), not tested.
- "The check never runs on its own on an already-accepted request. When a person invokes it on one, a confirmed split produces the same slices and records as a split at intake": (c) observed for the slices and records; "never runs on its own" is read from the skill text.
- Foreign-claim refusal (d): see the (d) note above; no listed criterion.

## Files Touched
- `docs/history/20261124-100000_feature-request-breakdown.md` - this entry. Scratch work lived under the OS temp dir and is not in the repo.
