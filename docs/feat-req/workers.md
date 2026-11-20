---
date: 2026-11-19
priority: High
severity: Low
status: DESIGNED
source: Promoted from docs/kit-open-items.md ("Parallel agents / task claiming"), shaped in a 2026-11-19 discussion
---

# Workers and the meta-root work board

> **Binding contracts.** The worker lifecycle, the claim protocol, the request file format and the `board/` layout below are requirements, not suggestions: the acceptance criteria test against them. Design must honour them or amend them explicitly, with the reason recorded in the design doc. Only "Solution Direction" is non-binding.

## Problem & Context

The kit assumes one worker pulling from one queue, and that worker is whatever Claude Code or Copilot session a person happens to have open. `select-next-task` says so, `workspace/.current-effort` holds a single effort, and ADR 001 names per-effort directories as the deferred upgrade path. As a result, throughput is capped at one effort at a time. Nothing can be started on another machine to take more work.

If a second session runs `/select-next-task` today, it ranks the same queue, picks the same top item and starts duplicate work, because nothing tells it the item is taken. And when the single worker hits a hard stop (design approval, triage, review findings), all work stops until a person answers.

## The two concepts

- **Worker**: a persistent entity owned by a user. You create it once with `sdlc worker create`, which registers it in the meta repo and gives it a private home on your machine (its own clone of the meta repo plus the code repos its current effort needs). After that you can start and stop it as often as you like. While it runs, it repeats a loop: take work, do it with an agent CLI, report back. A machine can host any number of workers, and they share no files. Each one is tracked by its id from creation to retirement.
- **Meta repo as the work board**: the shared meta repo remote is the only coordination point. Workers read the queue from it, claim work in it, renew leases and report progress and results to it, and post the gates that wait on a person. People use it the same way: they file feature requests, clear gates and watch status there.

## Worker lifecycle

1. **Create.** `sdlc worker create` (run by a user, with an agent CLI, a model and optionally a name) does four things:
   - resolves the owner's GitHub login with `gh` and generates the worker id: the login plus a short random suffix of 6 to 8 characters, for example `lidorl-7f3a9c`;
   - creates the worker's home on the local machine and writes the worker's config into it (id, agent CLI, model);
   - clones the meta repo into that home;
   - registers the worker on main with the same pull, commit, push, validate steps as a claim. Registration fails if the id is already taken.
2. **Run.** `start` runs the worker's loop in the current terminal. `start --detach` runs it in the background, so it survives a closed terminal, with a pid file and a log file in the worker's home. `once` takes one task and exits. `stop` ends the loop cleanly and releases any claim. A stopped worker keeps its identity and home, and the next `start` resumes as the same worker. Starting and stopping each push one small event commit, so the board knows whether a worker is running.
3. **Retire.** `sdlc worker retire` releases any claim, marks the worker retired in the registry and deletes its local home. The registry entry is kept, never deleted, because claims and history entries refer to the worker's id.

**The registry** has one file per worker on main (`board/workers/<id>.yml`). It holds the worker's durable identity:
- **owner**: the GitHub login of the user who created it;
- **name, host, agent CLI and model**;
- **created_at, and retired_at** once retired.

The registry doesn't store volatile state, and a running worker never pushes heartbeats. The board derives each worker's state (running idle, working, stopped, stale, retired), its current effort and its last-seen time from its start and stop events, claims and reports.

**Worker config** lives in the worker's home and sets the agent CLI and the model the worker runs every phase with, plus any CLI options. The model is mirrored in the registry so the board shows what each worker runs. Changing the model updates both the local config and the registry, with the same pull, commit, push, validate steps. A worker refuses to start if its local config and its registry entry disagree.

**Traceability**: every commit a worker pushes is authored as its owner and carries a `Worker: <id>` trailer. Claims, history entries and takeover records name the worker id, so any change can be traced from effort to worker to user.

## Claim protocol

A **claim** is a commit on the meta repo's main branch that records `claimed_by` and `claimed_at` on a feat-req. A worker owns an effort only while its claim is on main and nobody has replaced it. A claim that exists only locally, on another branch or in a rejected push doesn't count.

A worker follows these steps, in order, before it starts any work:

1. **Pull.** Fast-forward the worker's meta repo clone to `origin/main`.
2. **Check.** Rank the queue and pick an effort that has no live claim on main and isn't `awaiting` an open request.
3. **Commit the claim.** The commit changes only that feat-req's claim fields.
4. **Push to main.** If the push is rejected, the claim doesn't exist: reset to `origin/main` and go back to step 1. The worker never force-pushes, and if a rebase conflicts on the claim fields it never resolves the conflict in its own favour. It aborts and starts over.
5. **Validate.** Pull again and confirm two things: the claim commit is on `origin/main`, and `claimed_by` there is still this worker. If either check fails, someone else holds the effort, so the worker drops it and goes back to step 1.
6. **Start the work** only after step 5 passes.

The worker repeats the step 5 check before every report it pushes (phase transitions, lease renewals, artifacts). If it finds it no longer holds the claim, for example after a takeover, it stops work on that effort and pushes nothing further to it. Releasing a claim and taking over a stale claim follow the same pull, commit, push, validate steps.

**Interactive sessions follow the same rule.** One lease TTL applies to every claimant. A session renews its lease only when it reports, so a long discussion or a wait at a hard stop can let its claim go stale and be taken over. Before every report, the session re-validates like a worker. If its claim was taken over, it tells the person, names the worker that holds the effort now, and pushes nothing further to it.

## Requests to people

A headless worker can't ask anyone anything in a terminal. So every time it needs a person, it posts a **request** to the board and moves on instead of waiting. There are four kinds:

- **Gate**: one of the always-hard-stop approvals (design approval, triage, review findings), or a gate the Autonomy Policy sets to `confirm`, `discuss` or `pause`.
- **Question**: the agent needs a decision or information to continue, for example two valid readings of a spec.
- **Clarification**: the agent made an assumption it wants confirmed. Unlike a question, the worker may keep going while it waits, and records the assumption in the effort's docs.
- **Error**: something failed that the worker can't fix itself. It carries the error message and a short log excerpt. Errors come in two kinds:
  - **effort errors**, such as a failing build it can't resolve or a rejected push to a code repo;
  - **worker errors**, such as an expired `gh` login, a missing agent CLI, an unavailable model or a crash detected on the next start.

How it works:
- Each request is its own file on main (format below), so posting or answering one never conflicts with a claim.
- A blocking request (a gate, a question or an effort error) is posted in the same commit that sets `awaiting: <request id>` on the effort's feat-req and releases the claim. The lifecycle `status` doesn't change. A clarification doesn't block the effort.
- A worker error puts the worker into a "needs attention" state. The worker takes no new work until its owner resolves the error.
- A person answers by writing the answer into the request and pushing, with `sdlc answer` or by editing the file. That commit touches only the request file. The effort becomes claimable again because its `awaiting` request is answered.
- The board's inbox lists every open request, grouped by the person it's for, oldest first.
- Requests are temporary. What lasts is the decision, which ends up in the effort's docs (see the request lifecycle below).

### Request file format

**Layout.** Board data that isn't an effort doc lives under `board/`, next to `docs/`:

```
board/
  workers/lidorl-7f3a9c.yml        # worker registry, kept forever
  requests/202611191253-a1b2c3.md  # one file per request, temporary
```

The request id is a timestamp (`YYYYMMDDHHMM`) plus a random 6-character suffix. Workers create ids without coordinating, and the filenames sort by age.

**Frontmatter**

```yaml
id: 202611191253-a1b2c3
kind: question        # gate | question | clarification | error
gate: null            # design-approval | triage | review-findings | <policy gate>
scope: effort         # effort | worker
effort: bulk-export   # null for worker errors
phase: PLANNED        # the effort's status when posted
worker: lidorl-7f3a9c
for: lidorl           # a GitHub login, or "approvers" for gates
blocking: true
status: open          # open | answered | withdrawn
created_at: 2026-11-19T12:53:00+08:00
answered_by: null     # always the person's GitHub login
answered_at: null
answered_via: null    # cli | file | slack (future)
external: {}          # references in other channels, e.g. a Slack thread (future)
```

**Body sections**

- `## Request` (always): the ask, in one or two sentences.
- `## Context` (always): what the worker was doing, with `key:path` links to the relevant docs.
- `## Options` (questions): labelled choices and the worker's recommendation, so most answers are one letter.
- `## Assumption` (clarifications): what was assumed and where it was applied.
- `## Error` (errors): the message, a log excerpt of at most 50 lines, and what the worker already tried. Secrets are redacted before the file is written, always. This is a shared repo.
- `## Answer` (filled by the person): the decision and any notes.

### Answers and their effects

| Kind | The person answers | Effect, applied by the next worker that claims the effort |
|---|---|---|
| Design gate | approve, or reject with notes | Approve: design doc `APPROVED`, effort `DESIGNED`. Reject: design doc stays `DRAFT`, the notes become design input, and the effort returns to Design |
| Triage gate | accept, park or reject, with a reason | Sets the feat-req `status`. Park and reject record the reason in `## Triage` |
| Review gate | per finding: fix, or accept with a rationale | Each fix becomes a new unchecked plan step. Each accepted finding's rationale is recorded where the Definition of Done expects it |
| Policy gate | approve or reject | The gated step proceeds, or the effort returns to the previous phase with the notes |
| Question | an option letter or free text | The worker continues with the answer |
| Clarification | confirm, or correct with text | Confirm: nothing changes. Correct: a rework step is added to the plan. If the effort is already `IMPLEMENTED`, a follow-up feature request is filed instead |
| Effort error | retry, park, or instructions | Retry: the worker resumes. Park: the feat-req becomes `PARKED` with the error as the reason. Instructions: the worker resumes with them |
| Worker error | resolved, with notes | The worker leaves "needs attention" and takes work again |

Answering only writes the answer. Every lifecycle change is applied by a worker, or by an interactive session running the kit's skills, so clients like the `sdlc` CLI, a future control app or a Slack bridge never change lifecycle state themselves. The cost is that an approval takes effect when a worker next claims the effort, not the moment it is given.

A clarification correction can arrive while a worker still holds the effort. The worker checks for answered clarifications on its own effort at every report, and adds the rework step before it continues.

### Request lifecycle

1. **Posted.** A worker writes the file with `status: open`. If the request blocks, the same commit sets `awaiting` on the feat-req and releases the claim.
2. **Answered.** A person fills `## Answer` and the `answered_*` fields, and sets `status: answered`. A second answer to an already-answered request is rejected.
3. **Applied.** The next worker that claims the effort reads the answer and applies its effect. It records the decision in the effort's docs (the history entry's Decisions, or the design doc) and cites the request id.
4. **Removed.** In the same commit as step 3, the worker deletes the request file and clears `awaiting`. Git history keeps the full exchange.

A request can also be **withdrawn** by the worker that posted it, for example when a question became moot. It is then deleted with a one-line note in the effort's history entry.

## Controlling workers

**The board is the interface.** A worker never talks to a person directly, not even through its own terminal. Everything a person needs (status, updates, requests and answers) goes through the board. So a detached worker is exactly as reachable as a foreground one, and the person can be on any machine.

**v1 is one control CLI**, `sdlc`, that is a client of the board. It pulls, reads and pushes, and talks to no worker process except to start or stop one on the local machine.
- **Workers**: `sdlc worker create | start [--detach] | once | stop | status | list | retire`.
- **Status and updates**: `sdlc status` renders the board: workers by owner, efforts in flight and the inbox. `sdlc watch` polls the board and prints new events as they land: claims, phase transitions, requests and answers.
- **Requests**: `sdlc inbox` lists your open requests, oldest first. `sdlc answer <request-id>` shows a request with its context and records your answer, approval or rejection.

A foreground worker also prints its own requests and errors to its terminal as they're posted, but that output is only a convenience. The answer always goes through the board.

**Future direction (not this effort).** A full control app, as a terminal UI or a GUI, would let you manage workers, watch status, get notified and answer questions, clarifications and approvals in one place. Because workers only speak to the board, that app is just a richer client of the same board. Building it must not require changing the worker or the claim protocol.

## Users & Personas

- **Operator**: the user who creates, starts, stops and retires workers on one or more machines, and owns the workers they create.
- **Team lead**: tracks which workers exist, who owns them and what each is doing.
- **Team adopter**: several people share one meta repo remote. Their interactive sessions take part on the board like workers.
- **The worker**: needs to know what is free, what it holds and what is stale, and must never act on another worker's effort.
- **The approver**: needs one place to see every gate waiting on a person and to clear it.

## Scenarios

- As an operator, I run `sdlc worker create` on a fresh machine with the meta repo URL. It creates the worker's home and registers the worker on main under my name. I then `start` it, and it claims the top free item and starts working. I didn't open a session or set up anything else.
- As an operator, I create three workers on my laptop and start them. Each claims a different effort, and the board shows all three under my name, with their worker ids and the host they run on.
- As an operator, I stop a worker for the night and start it the next morning. It comes back as the same worker, with the same id and home.
- As a team lead, I open the board and see every worker, grouped by owner, with its state and current effort.
- As an operator, I retire a worker. Its claim is released and its home deleted, but its registry entry stays, so history entries that name it still resolve.
- **Unhappy path:** `sdlc worker create` can't register because the push is rejected or the id is already taken. It retries with a fresh pull, and if the id is taken it generates a new one. It never leaves an unregistered worker home behind.
- As two workers that pick the same item at the same moment, one claim reaches main first. The other worker's push is rejected, so it resets, pulls, re-ranks and claims something else, with no duplicate work.
- **Unhappy path:** a worker's push is accepted, but when it pulls to validate, main shows another worker in `claimed_by` (for example, a takeover landed in between). It drops the effort without starting work.
- As a worker, I report on every phase transition by pushing status, a lease renewal and the phase's artifact (design doc, plan, history entry) to the board.
- As a worker that reaches design approval, I post the gate to the board, release my claim and take other work. The approver sees it in the inbox.
- As the approver, I clear a gate on the board. The effort becomes claimable again, and any free worker picks it up.
- As a person in an interactive Claude Code session, I run `/select-next-task`. My session claims through the same board, so workers skip what I hold.
- **Unhappy path:** I spend longer than the lease TTL in a design discussion in my interactive session, and a worker takes the effort over. When my session next reports, it re-validates, tells me the effort is now held by that worker, and pushes nothing further to it.
- **Unhappy path:** a worker's machine dies mid-development. After the lease TTL its claim is stale. Another worker takes it over, builds the effort in its own workspace and resumes from the plan's first unchecked step.
- **Unhappy path:** a worker that was offline comes back and finds its claim taken over. It stops work on that effort, pushes nothing further to it and reports it.
- As a worker, I hit two valid readings of a spec while planning. I post a question to the effort's owner, release the claim and take other work. When it's answered, whichever worker claims the effort next reads the answer and continues.
- As a worker, I assume a default page size while building. I post a clarification and keep going, and the assumption is recorded in the history entry.
- As an owner, I run `sdlc inbox` and see every question, clarification, gate and error my workers posted, oldest first. I answer them in one pass with `sdlc answer`.
- As an owner with three detached workers, I close my terminal and later run `sdlc watch` from another machine. I see their progress and new requests as they land.
- **Unhappy path:** the agent CLI crashes or times out mid-phase. The worker posts an effort error with the message and log excerpt, releases the claim and backs off. It doesn't retry forever.
- **Unhappy path:** a worker's `gh` login expires. It posts a worker error and stops taking work until I fix it. The board shows it as needing attention.
- **Unhappy path:** a worker picks an effort whose repos overlap with another in-flight effort. It proceeds, but warns, naming the overlapping efforts and repos. Conflicts surface at PR time on separate `feat/<slug>` branches.

## In Scope

- **The `sdlc` control CLI**, shipped with the kit: the worker lifecycle commands (`create`, `start [--detach]`, `once`, `stop`, `status`, `list`, `retire`), plus `status`, `watch`, `inbox` and `answer`.
- **The worker runtime**:
  - Each worker has an independent, persistent home containing its own clone of the meta repo and a `workspace/` for code repos. A machine can host many workers side by side.
  - It runs the agent CLI it is configured for (Claude Code or Copilot CLI) headless on the routed phase.
  - It reports the result to the board, and it stops cleanly on a signal, releasing its claim.
- **The worker registry** on main: durable identity only (owner, name, host, agent CLI, created and retired dates). State is derived from events, claims and reports.
- **Traceability**: owner authorship plus a `Worker: <id>` trailer on every worker commit.
- **Claiming**: the claim protocol above. Claims live on main and count only once they're on main and validated there.
- **Leases**: renewed on every phase transition and report. A stale-claim TTL is configurable, applies to workers and interactive sessions alike, and takeovers are recorded.
- **Reporting**: each phase transition is pushed to the board with its status, lease renewal and artifacts.
- **Requests to people**: gates, questions, clarifications and errors, as files under `board/requests/` in the request file format. Blocking requests set `awaiting` and release the claim. Answers are applied by the next worker per the effects table, folded into the effort's docs, and the request file is removed.
- **Worker config**: the agent CLI, the model and CLI options per worker, mirrored to the registry.
- **The STATUS.md board view**: a workers table grouped by owner (id, name, host, state, current effort, last seen), an inbox of open requests grouped by the person they're for, and the claimant and claim age (with a stale flag) for every in-flight effort.
- **Interactive sessions**: they claim, re-validate and report through the same mechanism and lease rule, so people and workers share one board.
- **An overlap warning** at pick time when an effort's repos intersect another in-flight effort's repos.
- **`select-next-task` ranking changes**: skip live claims and efforts awaiting an open request, and count only unclaimed or stale efforts under "in-flight before new".
- **Doc updates**: `CLAUDE.process.md` (State, Autonomy Policy, new "Workers and the board" section), the affected skills, `assemble-env.mjs`, `clean-env.mjs`, `render-status.mjs`, the installer and the README. A new ADR amends ADR 001.

## Out of Scope

- A central dispatcher or scheduler. Workers pull from the board; nothing pushes work to them.
- Splitting one effort across several workers. Inside a single effort, `subagent-driven-development` already parallelizes plan tasks.
- Removing or relaxing hard stops (point 2 of the factory review, a separate effort).
- Automated acceptance gates (point 3) and deploy or production feedback (point 4).
- A terminal UI or GUI control app (the future direction above; `BRAINSTORMING.md` §12, a separate feature request).
- Push notifications (phone, email, chat). `sdlc watch` is the v1 way to follow updates.
- A Slack bridge that sends requests to people and writes their Slack replies back to the board (`BRAINSTORMING.md` §13). This effort only leaves room for it; see Constraints.
- Running workers as system services or containers, and provisioning machines for them. The worker runs wherever it is started.
- Auto-scaling the number of workers.
- Cross-effort merge-order coordination within a shared repo beyond the pick-time warning.
- Non-GitHub hosts and the Copilot cloud agent (unchanged from today).
- Access control over who may clear a gate.
- Protecting a live interactive session's claim from takeover. One lease rule applies to everyone.

## Acceptance Criteria

- [ ] `sdlc worker create`, given only a meta repo URL, an agent CLI and a model, creates the worker's home and registers the worker on main under the creating user's GitHub login, with an id of the form `<login>-<6 to 8 random characters>`.
- [ ] Every phase a worker runs uses the model from its config. The board shows each worker's model, and changing it updates the registry. `start` then claims work with no other setup.
- [ ] Several workers created on one machine get distinct ids and homes, share no files, and run at the same time without interfering.
- [ ] A stopped worker restarts with the same id and home. Its registry entry is unchanged.
- [ ] `sdlc worker retire` releases any claim, marks the registry entry retired and removes the local home. The entry stays on main.
- [ ] A worker never claims or reports unless its id is registered and not retired on main.
- [ ] Every commit a worker pushes is authored as its owner and carries a `Worker: <id>` trailer.
- [ ] A running worker pushes no heartbeat commits. Its state and last-seen time on the board come from its start and stop events, claims and reports.
- [ ] Two workers on different machines running against the same meta repo never claim the same effort. The losing push re-ranks and claims a different item. Covered by a test that simulates the race against a bare remote.
- [ ] A worker never starts work on an effort until its claim commit is on `origin/main` and a fresh pull shows `claimed_by` is still that worker. Tests cover a rejected push, a rebase conflict on the claim fields and a claim replaced between push and validation.
- [ ] A worker never force-pushes to main, and never resolves a conflict on claim fields in its own favour.
- [ ] No worker or session claims an effort that is `awaiting` an open request.
- [ ] Before every report, a worker or interactive session re-validates its claim on main and pushes nothing for an effort it no longer holds. An interactive session that lost its claim tells the person which worker holds the effort now.
- [ ] Every phase transition a worker completes appears on the board, with updated status, a renewed lease and the phase's artifact.
- [ ] A claim older than the TTL with no renewal is treated as stale, whether a worker or an interactive session holds it. A takeover builds the effort in the new worker's workspace and resumes from the first unchecked plan step.
- [ ] A worker whose claim was taken over stops on its next sync and pushes nothing further to that effort.
- [ ] At each always-hard-stop gate, the worker posts the gate, releases the claim and takes other work. Clearing the gate makes the effort claimable.
- [ ] A worker can post a question, a clarification and an error. A question and an effort error block the effort and release the claim, and a clarification doesn't. Every request reaches the inbox of the person it's for.
- [ ] An answered request makes the effort claimable again, and the next worker that claims it has the answer in its context before resuming.
- [ ] Every request file follows the request file format: valid frontmatter, the required body sections for its kind, and an id that sorts by age. A check script validates it in tests.
- [ ] Error excerpts are redacted for secrets before they're written. Tests use planted tokens in common formats.
- [ ] Each answer kind in the effects table produces its effect when the next worker claims the effort. Each effect is covered by a test.
- [ ] A clarification corrected while a worker holds the effort adds a rework step before the worker continues. One corrected after `IMPLEMENTED` files a follow-up feature request.
- [ ] After applying an answer, the decision appears in the effort's docs citing the request id, and the request file is gone from main.
- [ ] Clients that answer requests (the `sdlc` CLI, file edits) change only the request file, never lifecycle state.
- [ ] An agent CLI failure or timeout posts an effort error with the error message and a log excerpt, releases the claim, and the worker backs off before taking more work.
- [ ] A worker error (for example a lost `gh` login or an unavailable model) shows the worker as needing attention, and it takes no new work until the error is resolved.
- [ ] Stopping a worker with a signal releases its claim and shows it as stopped on the board.
- [ ] `sdlc worker start --detach` returns at once. The worker keeps running after the terminal closes, logs to its home, and `sdlc worker stop` ends it cleanly.
- [ ] A detached worker's requests reach the person through `sdlc inbox` on any machine, and an answer given with `sdlc answer` reaches the worker through the board.
- [ ] `sdlc watch` shows claims, phase transitions, requests and answers within one poll interval of their landing on main.
- [ ] No worker feature depends on a person reading the worker's terminal.
- [ ] `docs/STATUS.md` shows a workers table grouped by owner, the inbox of open requests grouped by the person they're for, and the claimant and claim age (with a stale flag) for every in-flight effort.
- [ ] An interactive session's `/select-next-task` claims through the board, and workers skip what it holds.
- [ ] Picking an effort whose repos overlap with an in-flight effort prints a warning naming both efforts and the shared repos, then proceeds.
- [ ] With no workers running, a single interactive session produces the same artifacts as today plus the claim fields. No existing test regresses.

## Success Metrics

- Adding capacity means creating and starting one more worker, with no other setup.
- For any change on main, you can tell which worker made it and which user owns that worker.
- Over a week of real use with two or more workers, there is zero duplicate work on one effort.
- Worker idle time at hard stops is near zero, because workers move on instead of waiting.
- Every stale claim is recovered without manual file edits.
- Efforts in flight at once rise above one, while the solo single-session experience is unchanged.

## Constraints & Dependencies

- **Dependencies:** a shared meta repo remote that every worker can push to; a headless-capable agent CLI on each worker machine (Claude Code CLI or Copilot CLI) that accepts a model choice; `gh`, authenticated, which is now required to create a worker as well as for PR checks; Node 20+; the multi-repo execution environment (already implemented).
- **Constraints:**
  - Claims and reports go to the meta repo's main branch, so workers must be allowed to push to main directly. A main protected by required PRs or reviews blocks the protocol. Adopters can still forbid force-pushes, and should.
  - Reports must stay small and rarely conflict.
  - Board traffic must not drown the meta repo's history in heartbeat commits.
  - `docs/STATUS.md` stays generated and git-ignored, so each worker or person renders it locally after a pull.
  - Headless agents need a permission setup that lets them work unattended inside the worker's home, and nowhere else.
  - Requests must leave room for other answer channels, starting with Slack, without any worker changes. A request records how it was answered (`answered_via`) and can hold external references such as a chat thread id. `answered_by` is always the person's GitHub login, even when a bot pushes the answer. A second answer to an already-answered request is rejected.
- **Interacts with:** ADR 001 (one shared workspace becomes one workspace per worker); the Autonomy Policy (a headless worker can't ask questions, so every gate set to `confirm`, `discuss` or `pause` becomes a gate posted to the board); point 2 of the factory review.

## Open Questions

- **How `sdlc` ships**: a `.mjs` entry point in the kit, matching the other scripts, or a separately installable npm CLI? A future control app suggests the latter.
- **Worker home location**: under the user's home (for example `~/.sdlc/workers/<id>/`) or a path the operator chooses?
- **Moving a worker**: should a worker be able to move to another machine under the same id? Technically yes, since that means copying its home and updating the host in the registry. Kept open.
- **Silent crashes**: a worker that crashes hard pushes no stop event and posts no error. Should the board flag a worker that shows as running but has pushed nothing for a long time, and should its next start post a worker error for the crash?
- **Notifications**: requests live as files on main, so nobody is told when one arrives. v1 relies on `sdlc inbox` and `sdlc watch`. Is that enough until the Slack bridge (`BRAINSTORMING.md` §13), or is a lightweight interim needed, such as a GitHub mention or issue that only links to the request file?
- **Approval latency**: an approval takes effect only when a worker next claims the effort. Should `sdlc answer` nudge a free worker on the same machine to pick it up right away?
- **Redaction**: which patterns count as secrets, and should a redaction failure block the request (safer) or post it with the excerpt dropped?
- **Polling**: how often does `sdlc watch` pull, and is that configurable? Should events have a defined format now, so a future control app can consume the same stream?
- **Answering from a session**: besides `sdlc answer`, should there be a skill (for example `/answer`) so a person can answer from inside Claude Code or Copilot?
- **Model validation**: should `sdlc worker create` check that the model exists for the chosen agent CLI before registering?
- **Claim commit format**: a fixed message such as `claim(<slug>): <worker-id>` so `git log` reads as a claim history?
- **Headless invocation**: what exactly does the worker run per phase (for example `claude -p` with a phase prompt), and how does the agent tell the worker it stopped at a gate rather than finished or failed? An exit code, or a result file?
- **Defaults**: the lease TTL and where it is configured, the Autonomy Policy block or a new `workers:` block.
- **Interactive vs headless identity**: do interactive sessions register in the worker table, or only appear as claimants? Either way, `claimed_by` needs an id for them.
- **Approvers**: gates go to `for: approvers`. Who counts as an approver, and whose `sdlc inbox` shows those gates? Access control is out of scope; routing is not.
- **Empty queue**: what does a worker do? Run `gather-open-items` (claimed like an effort, so only one sweep runs at a time), idle and poll, or exit in `once` mode?
- **Overlap**: should the warning take `depends_on` in `repos.yml` into account, or only direct repo intersection?

## Solution Direction

*Non-binding. This is the shape agreed on 2026-11-19; Design confirms or revises it.*

- **Workers are entities.** A user creates each one once and registers it on main. It runs and stops many times, and is retired but never forgotten.
- **Worker loop**: check the registration is active → claim by the claim protocol (pull, check, commit, push to main, validate) → build the effort's workspace in the worker home → run the agent CLI headless on the routed phase → report (push status, lease renewal and artifacts) → release at a gate or at close-out → repeat.
- **The meta repo is the board.** Everything shared lives there, and nothing else coordinates workers. A worker's home is private to it and lasts until the worker is retired.
- **Leases, not locks.** Any worker may take over a claim that is past its TTL, and records the takeover.
- **Requests go on the board.** A headless worker never waits on a person. It posts a gate, question, clarification or error, releases the claim if the request blocks, and picks something else. The STATUS.md inbox is the person's queue.
- **People are first-class on the board.** Interactive sessions claim and report through the same mechanism.
- **The board is the API.** The `sdlc` CLI is its first client, and a future control app is the next. Workers never need to know which client a person uses.
- **Overlap is allowed.** Separate `feat/<slug>` branches per effort, a warning at pick time, and conflicts resolved at PR time.

## Related Docs

- `docs/kit-open-items.md` (source item)
- `docs/decisions/001_meta-root-with-git-ignored-workspace.md` (per-effort dirs named as the upgrade path)
- `docs/feat-req/execution-environment.md` and `docs/design/execution-environment.md` (the workspace this extends)
- `skills/select-next-task/SKILL.md` (single-worker assumption)
