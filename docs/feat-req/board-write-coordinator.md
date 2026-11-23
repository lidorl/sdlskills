---
date: 2026-11-23
priority: Medium
severity: Low
status: ACCEPTED
source: Extracted from 02-board-write-coordinator.md (2026-11-23 software-factory discussion), widening BRAINSTORMING §14 from claims to every board write
---

# GitHub workflow coordinator for board writes

> **Binding contracts.** These are requirements, and the acceptance criteria test against them: in `pr` mode every board write is a pull request that the coordinator merges or closes; the coordinator handles the whole queue in each run; one validation library serves the workflow and the direct-push clients; and a write counts only once it is on main. Design must honour them or amend them explicitly, with the reason recorded in the design doc. Only "Solution Direction" is non-binding.

## Problem & Context

In the workers design (`docs/feat-req/workers.md` and ADR 005, on `feat/workers-design`), every worker, interactive session and `sdlc` command pushes board writes straight to main. That causes three problems:

- **Main can't be protected.** ADR 005 states the consequence: a main protected by required PRs blocks the protocol, so adopters must allow direct pushes from every worker.
- **Every client has to implement the protocol correctly.** Each client must run pull, commit, push, validate, and on a rejected push the rebase and restore logic. That is the most intricate code in `scripts/lib/board/git.mjs`, and every future client (the control app in BRAINSTORMING §12, the Slack bridge in §13) would have to get it right too.
- **Validation is spread across clients.** Rules such as "a claim touches only the claim fields of one feat-req" or "a review result touches only its own request file" are checked, if at all, by the client that writes. Nothing on the server side enforces them.

The independent verification request (`docs/feat-req/independent-verification.md`) also needs a server-side place to enforce its independence rule.

## Users & Personas

- **Team lead / repo admin**: wants main protected, with no worker or person able to push to it directly, and wants a break-glass path when GitHub Actions is down.
- **Operator**: runs workers and wants board writes to land without babysitting, at an Actions cost they can predict.
- **Worker and interactive session**: write to the board (claims, reports, requests, answers, register, retire) and need to know when a write counts.
- **Person answering requests**: answers gates and questions with `sdlc answer` or by editing a request file.
- **Small adopter**: a GitHub Free private repo, or a tight Actions budget. Can't protect main and may not want to pay per write, so needs the direct-push mode to keep working.

## Scenarios

- As a team lead, I protect main with a ruleset. No worker or person can push to it, and every board write still lands through the coordinator.
- As a worker, I claim an effort by opening a PR that changes only that feat-req's claim fields. The coordinator merges it within a minute or two, and only then do I start work.
- As two workers claiming the same effort at the same time, one PR merges. The other is closed with the reason "live claim held by <worker>", and that worker re-ranks and claims something else.
- As a CI verifier, I open a PR that changes only my review request file. It is checked against the independence rule and merged automatically.
- As a person, I run `sdlc answer` on a gate. It opens a board PR, and the coordinator merges it.
- As a person, I edit a request file by hand and open a PR on a `board/` branch. The coordinator merges it if it touches only that request file.
- As a burst of ten workers reporting at once, the writes are handled by one or two coordinator runs, not ten.
- As a small adopter on GitHub Free, I set `writes: direct`. Workers push to main as today, and the client runs the same validation library before each push.
- **Unhappy:** a PR changes files outside the allowlist for its kind of write. It is closed with a reason naming the paths.
- **Unhappy:** a PR's author doesn't match the claimant, or the worker is retired or unregistered. It is closed with the reason.
- **Unhappy:** GitHub drops a waiting coordinator run under concurrency limits. Nothing is lost: the next run, or the hourly sweep, handles every open board PR.
- **Unhappy:** GitHub hasn't worked out yet whether a PR can merge. The run retries briefly, then leaves the PR for the next run.
- **Unhappy:** a worker waits longer than `board.write_timeout`. It closes its own PR, treats the write as not done, and retries later. A claim that was never merged never counted.
- **Unhappy:** Actions is down, so nobody can write to the board. An admin uses the documented break-glass bypass, and the board records the direct push as an event naming who pushed.
- **Unhappy:** a PR comes from a fork. The coordinator ignores it.

## In Scope

- **The coordinator workflow.** It is triggered by board PR events, plus an hourly scheduled sweep. Each run lists every open board PR and processes them one at a time, oldest first, each against the latest main (including merges made earlier in the same run). Each PR is merged or closed with a reason. Waiting runs dropped by the concurrency group are harmless by design.
- **Board PR identification.** Board PRs come from same-repo branches with the prefix `board/<worker-id>/<write-id>`, carry the `board-write` label, and are titled with the commit subject plus the worker id (for example `board(claim): bulk-export [lidorl-7f3a9c]`). Commit messages keep the existing `board(<kind>): …` subject and trailers unchanged. All other PRs are ignored and go through normal human review. Fork PRs are ignored. The prefix and label only select PRs; trust comes from the checks.
- **Server-side checks** for every board PR:
  - allowed paths for each kind of write;
  - identity: the worker is registered and not retired, and the PR author is the owner registered for that worker id in `board/workers/<id>.yml` (or, for an answer, the answering person). Identity is checked at the owner level. The worker id in the branch name, the commit's `Worker:` trailer and the PR title must agree;
  - claim rules: no live claim, and the effort isn't `awaiting` an open request;
  - the independence rule for review results, from the independent verification request.
- **Write tiers:**
  - **arbitrated**: claims, takeovers, register, retire, config;
  - **validated auto-merge**: reports, requests, answers, review results;
  - **reduced**: lease renewals only at reports, not on a timer, and start and stop events dropped or batched.
- **A validation library** in node (for example `sdlc board validate-pr`). The workflow calls it, local tests run it, and direct-mode clients run it before pushing.
- **`boardWrite` as the single primitive.** In `pr` mode it opens a branch and PR and waits up to `board.write_timeout`. In `direct` mode it keeps today's pull, commit, push, validate steps. The claim, request, effects and queue logic stays as is.
- **A merge that keeps the commit message.** The coordinator lands the worker's commit with its subject and trailers unchanged, by rebase-merge or by a squash that reuses the original message. The board's event log (`parseLog`) depends on them, and GitHub's default squash message would drop them.
- **The write mode**, set once per meta repo in `board/config.yml` as `writes: pr | direct`. The default is `pr`. Mixing modes in one meta repo isn't supported.
- **People's writes.** `sdlc answer` and the other `sdlc` commands open board PRs in `pr` mode. Hand-edited request files go through a board PR.
- **Break-glass.** A ruleset bypass for repo admins, documented. A direct push to main in `pr` mode shows on the board as an event naming who pushed.
- **Docs.** An ADR amending ADR 005, and amendments to the workers spec:
  - its "no central dispatcher" out-of-scope line, since the coordinator is now a central merger, though workers still pull their work;
  - its "a running worker pushes no heartbeat commits" criterion, so it matches renewals only at reports.

## Out of Scope

- **Worker-level proof of identity** (a signing key per worker, recorded in its registry entry and verified by the coordinator). It is deferred as an open item in `docs/kit-open-items.md`. In this spec, identity is checked at the owner level, so one owner's workers aren't protected from each other.
- **A coordinator running on a local always-on machine** (`sdlc coordinator`), which uses no Actions minutes. It is deferred as an open item in `docs/kit-open-items.md`. It would reuse the same validation library.
- A cron-only coordinator. It costs more when idle, and GitHub can delay or drop scheduled runs.
- GitHub merge queue as the mechanism.
- Hosts other than GitHub.
- Slack and notification bridges, and a control app.
- Mixed write modes in one meta repo, and migrating a live board between modes beyond a documented manual switch.

## Acceptance Criteria

- [ ] With `writes: pr` and main protected with no bypass for workers, create, claim, report, request, answer, review result and retire all work.
- [ ] Two simultaneous claims on one effort: exactly one merges, and the other is closed with a reason, after which that worker claims something else (tested against a fake coordinator).
- [ ] A PR touching paths outside the allowlist for its kind of write is closed with a reason naming the paths.
- [ ] A PR whose author isn't the registered owner of its worker id (or the answerer), or that comes from a retired or unregistered worker, is closed with a reason.
- [ ] A PR whose worker id differs between its branch name, its commit's `Worker:` trailer and its title is closed with a reason.
- [ ] After a merge, the commit on main has the worker's original subject and trailers, and `parseLog` reads it as the same event.
- [ ] One coordinator run processes every open board PR in creation order, each checked against main as it stands after the previous merge.
- [ ] Dropping a waiting run loses no write: every open board PR is processed by a later run or by the hourly sweep.
- [ ] PRs that aren't board writes, and PRs from forks, are never merged or closed by the coordinator.
- [ ] The validation rules live in one node library. The workflow, the direct-mode client and the tests all call it.
- [ ] With `writes: direct`, the board works as it does today, and the client rejects a write that the library rejects before pushing.
- [ ] A worker that hits `board.write_timeout` closes its PR and treats the write as not done.
- [ ] The default `lease_ttl` is greater than the worst-case write delay, and a delayed merge doesn't make a healthy claim stale.
- [ ] A direct push to main in `pr` mode appears on the board as an event naming who pushed.
- [ ] Without `board/`, nothing changes for a solo session.

## Success Metrics

- **Write latency:** p95 time from opening a board PR to its merge or close is under 2 minutes (proposed target; confirm against the first real runs).
- **Actions cost:** Actions minutes used per 100 board writes, measured from the coordinator's run records. It should fall well below the one-run-per-write baseline of about 100 minutes, because bursts share runs and the reduced tier cuts writes.

## Constraints & Dependencies

- **Dependencies:**
  - Workers and the work board (`docs/feat-req/workers.md`, branch `feat/workers-design`), especially `boardWrite` in `scripts/lib/board/git.mjs` and the claim protocol.
  - The independent verification request depends on this one for how review requests and results land on main and for enforcing the independence rule.
- **Constraints:**
  - Merges made with `GITHUB_TOKEN` don't trigger other workflows. Where a merge must trigger a workflow (for example the CI verifier), the merge step needs a GitHub App token or PAT.
  - A concurrency group keeps only one waiting run and cancels older waiting ones. The design must stay correct under that, which is why each run handles the whole queue.
  - GitHub computes whether a PR can merge in the background, so a fresh PR may first show as unknown.
  - Scheduled runs can be delayed or dropped, so the hourly sweep is a safety net only.
  - Each Actions job is billed rounded up to a whole minute. GitHub Free private repos get 2,000 minutes a month and can't use branch protection or rulesets, which is why `direct` mode exists.
  - The workers feature is already GitHub-only.

## Open Questions

- What are the defaults for `board.write_timeout` and the brief retry when mergeability is unknown?
- Rebase-merge or squash with the original message: which one keeps main's history cleanest while preserving the event commits?
- Do start and stop events go away entirely or get batched, and how does the board then tell whether a worker is running?
- What exactly does the break-glass record look like, and how is a direct push in `pr` mode detected (the workflow on push, or the next run)?
- How does an interactive session report waiting for a write to the person without it feeling stuck?

## Solution Direction

Non-binding. A sketch:

```yaml
# board/config.yml
writes: pr               # pr | direct
board:
  write_timeout: 10m

# .github/workflows/board-coordinator.yml (outline)
on:
  pull_request: { types: [opened, synchronize, reopened, labeled] }
  schedule: [{ cron: '17 * * * *' }]   # hourly sweep
concurrency: { group: board-coordinator, cancel-in-progress: false }
# job: list open PRs with the board-write label from board/* branches, oldest first;
#      for each: refresh main, run `sdlc board validate-pr`, merge or close with the reason.
```
