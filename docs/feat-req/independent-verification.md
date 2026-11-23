---
date: 2026-11-23
priority: Medium
severity: Low
status: ACCEPTED
source: Extracted from 01-independent-verification.md (review of PR #17 and the 2026-11-23 software-factory discussion, 00-context-and-decisions.md)
---

# Independent verification stage with pluggable verifiers

> **Binding contracts.** These are requirements, and the acceptance criteria test against them: the `IN_REVIEW` status, the independence rule, the board as the only channel for review requests and results, the SHA check, the verifier's narrow context, the rule that a reviewer never fixes its own findings, and the human gate after the loop. Design must honour them or amend them explicitly, with the reason recorded in the design doc. Only "Solution Direction" is non-binding.

## Problem & Context

Today the agent that implements a change is also the only reviewer of it, and the kit has no automated acceptance gate. Agents are biased toward their own work, and passing tests that the same agent wrote prove little. The `/code-review` step in the Definition of Done runs in the implementer's own session, with the implementer's full context.

Two more problems come from that. First, human review gates turn into rubber-stamping when a person is handed a full diff with no prior independent pass. Second, the work board (`docs/feat-req/workers.md`, on `feat/workers-design`) can't show that an effort is under review: work goes straight from `IN_PROGRESS` to `IMPLEMENTED`.

In the software-factory coverage review (`00-context-and-decisions.md`), independent verification and feeding PR and CI results back into revision are both rated **weak**. This request addresses both.

## Users & Personas

- **Operator**: runs workers and wants reviews to happen without sitting in the loop.
- **Approver**: answers the review gate and wants a gate that has already been through an independent review loop, not a raw diff.
- **Team adopter**: either a small project with no CI budget (local backend) or a larger one that wants the review in its pipeline (CI backend).
- **Worker**: an execution slot that needs to know which role it plays on each run (implement, verify, …).

## Scenarios

- As an operator, my worker finishes an implementation. The effort moves to `IN_REVIEW`, and a different worker or model reviews it with no action from me.
- As an implement-role run on any worker, I claim an effort whose review result is in. Each finding becomes a fix step in the plan, I fix them, and the effort goes back to `IN_REVIEW` for the next round.
- As an approver, I get one `review-findings` gate after the loop ends. It shows the verdict, the round count, the backend, and each finding with its outcome (fixed and re-checked, accepted with a rationale, or deferred) plus anything the verifier escalated. I answer per finding, as today.
- As a small-project adopter with no CI minutes, I use the `local` backend, and my configured test and lint commands run in the verify stage.
- As a team with CI, I switch to the `ci` backend. The verdict arrives as a PR comment or check and as a board result.
- As a reader of the PR, I see the verdict as a marked comment with redacted findings. The board stays the source of truth.
- **Unhappy:** the loop doesn't converge in `max_rounds`. The effort goes to the same human gate, marked "did not converge", with the open findings listed.
- **Unhappy:** a new commit lands after the review started. The result's SHA isn't the branch head, so it is rejected and the effort is reviewed again.
- **Unhappy:** the CI verifier never reports. After `verify.timeout`, the next claimant posts an effort error.
- **Unhappy:** only one worker and one model exist. No review meets the independence rule, so the effort waits at the human gate and a person reviews it. A same-model review never counts as independent (see Out of Scope).
- **Unhappy:** a verifier tries to answer a review request that is already answered, and the write is rejected.
- **Unhappy:** the spend or token cap for the effort is hit mid-loop, and the effort goes to the human gate with the reason.
- **Unhappy:** a verifier run tries to read implementer history, decision logs or transcripts. The runtime-built directory doesn't contain them, and the permission deny rules block reads outside it.

## In Scope

- **The `IN_REVIEW` status**, between `IN_PROGRESS` and `IMPLEMENTED`. A takeover mid-review resumes at review, not implementation. This touches the State table in `CLAUDE.process.md`, routing in `select-next-task`, the candidate and in-flight sets in `queue.mjs`, and `render-status.mjs`.
- **Roles (hats) on workers.** Each run takes a role with its own prompt, skills and optional model. Every run records `Role:` and a run id in its commit trailers.
- **The independence rule, enforced in code.** The verify run must differ from the implement run in model or worker. Policy can require both for configured high-risk paths (for example auth, billing, public APIs). It is strict: a same-model, same-worker review never meets it.
- **A `review` request kind**, addressed to an agent role. It carries the effort, PR and branch, the commit SHA to review, the round, the backend, and the files the verifier may read. Review requests have claim fields with a lease.
- **The review result format**, written by the verifier into the request file only: verdict, findings F1, F2…, reviewed SHA, backend, model, and worker or bot. A result whose SHA isn't the current branch head is rejected. A second result on an answered request is rejected.
- **Result application.** The next implement-role claim turns findings into plan fix steps that cite the request id, records the decision, and deletes the request, following the existing request lifecycle. The reviewer never fixes its own findings. The next round re-checks each finding against the new diff and does not take "fixed" on trust.
- **The human gate after the loop.** When the loop passes, or stops at the round limit or the spend cap, the effort posts one `review-findings` gate. "Code/security review findings" stays an always-hard-stop in the Autonomy Policy.
- **Verify replaces the in-session `/code-review` when `board/` exists.** The Definition of Done item becomes "an independent verify run is recorded". `/security-review` runs inside the verify stage when its triggers apply.
- **The verifier's narrow context**, built by the runtime as a dedicated directory plus permission deny rules, not by prompt. It contains the acceptance criteria and binding contracts, the diff on a read-only checkout of the pushed commit, test and CI output, the stack file and repo conventions. A second pass may add the approved design, marked as settled. It excludes implementer history, decision logs, summaries and run transcripts.
- **Pluggable backends behind one contract.** With `local`, a worker claims the review and runs the agent. With `ci`, a GitHub Action runs the agent. Both read the request and write the result through the board.
- **Waiting on CI.** The effort releases its claim and sets `awaiting: <review request id>`. If no result arrives by `verify.timeout`, it becomes an effort error.
- **PR publication.** The verdict is posted as a marked PR comment or check run with a hidden machine-readable block, never as a formal approval. Findings are redacted before posting.
- **A deterministic floor.** The configured commands (tests, lint) run in the verify stage when there is no CI.
- **Limits.** Escalation to the human gate after `max_rounds`, and a spend or token cap per effort.
- **Follow-ups.** Deferred or accepted findings become follow-up feature requests, with an optional mirror to GitHub Issues.
- **Multi-repo efforts.** One verdict per PR. The effort passes only when every PR passes, and one gate covers the effort.
- **Tiers.** Trivial tier skips the agent review, but the deterministic floor still runs. Hotfix gets the agent review after the fact, as part of its mandatory follow-up.
- **Settings in `board/config.yml`**: backend, commands, max rounds, independence requirement, path overrides, timeout and cap.

## Out of Scope

- **A labelled same-model review** (opt-in `require_different: none`, recorded as `independence: weak`). It is deferred as an open item in `docs/kit-open-items.md`. In this spec the rule is strict.
- **Removing or relaxing human hard stops.** The review gate stays, and only what reaches it changes. "Fewer hard stops" is a separate effort (factory review point 2).
- Deploy and production feedback.
- A container or sandbox runtime for the verifier, which is a possible later execution mode.
- Access control over who may approve.
- Formal PR approvals by the verifier, since the PR author can't approve its own PR.
- Any change for a solo session without `board/`: `/code-review` runs in session as today.

## Acceptance Criteria

- [ ] An effort can't reach `IMPLEMENTED` without a recorded verify run that differs from the implement run in model or worker, or in both where policy requires it for the changed paths.
- [ ] A verify run with the same model and the same worker as the implement run is rejected by the independence check.
- [ ] After the loop ends (pass, round limit or spend cap), the effort posts exactly one `review-findings` gate that lists every finding with its outcome. It doesn't reach `IMPLEMENTED` before a person answers.
- [ ] STATUS.md shows `IN_REVIEW`, the round, the backend and the verdict counts.
- [ ] A takeover of an effort in `IN_REVIEW` resumes at review, not implementation.
- [ ] A result whose SHA differs from the branch head is rejected, and the effort is reviewed again.
- [ ] A second result on an already-answered review request is rejected.
- [ ] Each finding becomes a plan fix step that cites the review request id, and the request is gone from main once applied.
- [ ] The verifier's directory, as the runtime builds it, contains none of the implementer's history, decisions, summaries or transcripts, and reads outside it are denied (tested on the built directory and the generated deny rules).
- [ ] Results from the local and CI backends are accepted by the same ingestion code.
- [ ] With the `ci` backend, an effort waiting on a result releases its claim, and an effort error is posted after `verify.timeout` with no result.
- [ ] After `max_rounds` failing rounds, the effort goes to the human gate, marked "did not converge".
- [ ] Findings are redacted before they are posted to the PR (tests with planted tokens).
- [ ] A multi-repo effort passes verification only when every PR's verdict passes.
- [ ] A trivial-tier effort runs the configured commands and no agent review.
- [ ] Without `board/`, nothing changes for a solo session.

## Success Metrics

- **Primary:** the share of efforts that reach the human review gate with no open findings, measured from the gate records on the board. It should rise as the loop catches and fixes findings before a person sees them.

## Constraints & Dependencies

- **Dependencies:**
  - Workers and the work board (`docs/feat-req/workers.md`, branch `feat/workers-design`, Plan 3 still to build).
  - The board-write coordinator (`02-board-write-coordinator.md`, not yet filed), which decides how review requests and results land on main. Its server-side validation also enforces the independence rule.
- **Constraints:**
  - The workers spec criterion "every phase a worker runs uses the model from its config" must be amended, since roles can override the model.
  - Merges done with `GITHUB_TOKEN` don't trigger other workflows, so the `ci` backend needs an App token or PAT on the merging step.
  - The role mechanism must be general, not verify-specific: the thinking-hats request (`04-thinking-hats-definition-and-design.md`) plans to run its hats as role runs.
  - Contract and skills stay in sync: the State table, the Definition of Done, `select-next-task` and `close-out` change together, and any new wording must pass the Copilot rewrite test.

## Open Questions

- Should review be modelled as a request kind with claim fields (preferred), or as a claimable stage with a claim on the effort?
- Which model or CLI combinations count as "different" when only one agent CLI is installed (for example two models from the same vendor)?
- What are the defaults for `max_rounds`, `verify.timeout` and the per-effort spend cap, and is the cap in tokens or money?
- How does the gate show the verifier's escalations apart from ordinary findings?
- Where do the PR comment and the board result diverge if the PR comment can't be posted (for example missing permissions), and does that block the stage?

## Solution Direction

Non-binding. A sketch of `board/config.yml` (field names illustrative):

```yaml
verify:
  agent_review: local        # local | ci | off
  commands: [npm test, npm run lint]
  max_rounds: 3
  timeout: 30m               # ci backend: wait before an effort error
  require_different: model   # model | worker | both
  overrides:
    - paths: ["src/auth/**", "src/billing/**"]
      agent_review: ci
      require_different: both
```
