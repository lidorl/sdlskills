---
date: 2026-11-24
priority: Medium
severity: Low
status: ACCEPTED
source: User request (2026-11-24), promoted from BRAINSTORMING.md §12 (worker control app)
---

# Local web app for workers and board requests

> **Binding contracts.** These are requirements, and the acceptance criteria test against them: the app is a client of the board and follows the same rules as `sdlc` (answering only writes the answer; it never changes lifecycle state itself); it acts as the person running it, with their own credentials; it controls only workers on its own machine; it listens on 127.0.0.1 only and refuses any request without its startup token; and it calls the same core functions as the `sdlc` CLI. Design must honour them or amend them explicitly, with the reason recorded in the design doc. Only "Solution Direction" is non-binding.

## Problem & Context

The workers feature (`docs/feat-req/workers.md`, merged) gives people one client: the `sdlc` CLI. Everything a person does on the board is a separate command:
- `sdlc inbox` and `sdlc answer <id> --choice X --note "…"` for requests;
- `sdlc status` and `sdlc watch` for the board;
- `sdlc worker create --agent … --model …`, plus `start`, `stop`, `retire` and `config`, for workers.

The CLI has real gaps:
- You only learn something changed when you run a command.
- Answering a gate means finding its request id, then reading the design doc or PR elsewhere.
- Creating a worker means knowing every flag up front.

With several workers running, requests sit unanswered and workers stay blocked.

The workers spec already planned for this: "the board is the API", and a control app is "just a richer client of the same board" that needs no worker changes (BRAINSTORMING §12).

## Users & Personas

- **Approver**: answers gates (triage, design approval, review findings) and needs the context behind each one in the same place.
- **Effort owner**: answers questions, clarifications and effort errors addressed to them.
- **Operator**: creates, starts, stops, configures and retires the workers on their machine, and watches what all workers on the board are doing.

One person often holds all three roles. The app serves one person on their own machine.

## Scenarios

- As an approver, I open the inbox and see the open requests for me and for "approvers", oldest first, filtered by kind.
- As an approver, I open a design-approval gate, read the rendered design doc and the linked PR diff on the same page, and approve or reject with notes.
- As an approver, I triage a feature request (accept, park or reject with a reason) from the app.
- As an approver, I answer a review-findings gate per finding (fix, or accept with a rationale), with the verifier's findings shown once the verification feature exists.
- As an effort owner, I answer a question by clicking one of its options, or confirm or correct a clarification.
- As an operator, I create a worker through a multi-step wizard: agent, model, name, then sandbox setup. Each step is validated before I continue.
- As an operator, I start, stop, configure or retire a worker on this machine from its page.
- As an operator, I see every worker on the board with its state, current effort and last-seen time. Workers on other machines are view-only.
- As anyone, a browser notification tells me when a new request for me arrives while the app is open.
- As anyone, I run `sdlc web`, my browser opens on the app, and I never see or type the token.
- **Unhappy:** someone else answered a request first. My answer is rejected, and the app shows who answered and how.
- **Unhappy:** in the coordinator's `pr` mode, my answer is pending until its PR merges. The app shows it as pending, and shows a rejection with its reason if the coordinator closes it.
- **Unhappy:** a page from another site, or another user on the machine, sends a request to the app. It is refused for lacking the token.
- **Unhappy:** the board can't be reached (no network, expired `gh` login). The app shows the last known state, marked stale, with the error, and refuses writes until it recovers.
- **Unhappy:** the worker wizard fails a step, for example the agent CLI is missing or there is no sandbox. It shows the failure and the fix, and creates nothing.
- **Unhappy:** I try to start a worker that lives on another machine. There is no control for it, only its status.

## In Scope

- **Starting the app:** a `sdlc web` command starts a local server and opens the browser.
- **Inbox:** open requests for the person and for "approvers", oldest first, filterable by kind (gate, question, clarification, error). Answers use the request's options as buttons, plus free text and notes.
- **Gate context:**
  - the design doc rendered for design approval;
  - the spec rendered for triage;
  - links to the effort's PRs and diffs;
  - the verifier's findings for review gates, once the verification feature provides them.
- **Hard-stop answers:** triage (accept, park, reject with a reason), design approval (approve, or reject with notes), and review findings (fix, or accept with a rationale per finding).
- **Workers:**
  - a list of every worker on the board with state, current effort and last seen;
  - controls (start, stop, configure, retire) for workers on this machine only;
  - a multi-step create wizard that covers the sandbox setup from `docs/feat-req/worker-agent-isolation.md`.
- **Board status:** efforts and their phases, the equivalent of `sdlc status`, and the event stream from `sdlc watch`.
- **Live updates:** periodic refresh from the board, and browser notifications for new requests addressed to the person.
- **Identity:** the app acts as the person running it, through their existing git and `gh` credentials.
- **Same rules as the CLI:** answering only writes the answer. Writes go through `boardWrite`, so they follow the coordinator's `pr` or `direct` mode, with pending and rejected writes shown as such.
- **Local safety:**
  - it listens on 127.0.0.1 only;
  - it requires a random token generated at each start, delivered in the opening link and then kept in a cookie;
  - it protects against cross-site requests (CSRF) and DNS rebinding.
- **A shared core:** the app and the `sdlc` CLI call the same library functions for every read and write.

## Out of Scope

- Filing new feature requests, and any other step that needs an agent conversation. Those start from the agent (Claude Code or Copilot).
- A terminal UI (k9s-style). It stays an idea in BRAINSTORMING §12 and could reuse the shared core later.
- Hosting the app for a team, or access from other machines.
- Controlling workers on other machines.
- Accounts, logins or access control beyond the person's own git and `gh` credentials.
- Slack or other notification bridges (BRAINSTORMING §13).
- Changing lifecycle state directly. Every lifecycle change is still applied by a worker or a skill.

## Acceptance Criteria

- [ ] `sdlc web` starts the app on 127.0.0.1, prints a link with a fresh token, and opens it in the browser.
- [ ] Any request without the current token is refused, including after a restart with an old token. A request with a foreign `Origin` or `Host` header is refused (tested).
- [ ] The inbox lists exactly the open requests that `sdlc inbox` lists for the same person, in the same order.
- [ ] Answering a request from the app produces the same board change as `sdlc answer` with the same choice and note.
- [ ] Answering an already-answered request is rejected, and the app shows who answered.
- [ ] A design-approval gate shows the rendered design doc and links to the effort's PRs. A triage gate shows the rendered spec.
- [ ] Triage, design approval and review-findings answers are possible from the app, and each records the reason or notes the board expects.
- [ ] The worker list matches `sdlc worker list`. Start, stop, configure and retire appear only for workers on this machine.
- [ ] The create wizard produces the same result as `sdlc worker create` with the same choices, and creates nothing if any step fails.
- [ ] In `pr` mode, a write is shown as pending until it merges, and as rejected, with the reason, if it is closed.
- [ ] When the board can't be reached, the app shows stale data marked as such and refuses writes.
- [ ] A new request for the person triggers a browser notification while the app is open (if the person allowed notifications).
- [ ] The app never changes a feat-req `status` or design doc `status` itself (tested on the writes it makes).
- [ ] Every read and write goes through functions shared with the `sdlc` CLI. No board logic is duplicated in the app.

## Success Metrics

None set at intake, skipped by request. Revisit after the first release.

## Constraints & Dependencies

- **Dependencies:**
  - Workers and the `sdlc` CLI (`docs/feat-req/workers.md`, merged). The shared core may need parts of `scripts/lib/board/cli.mjs` and `scripts/lib/worker/cli.mjs` moved into callable functions.
  - The board-write coordinator (`docs/feat-req/board-write-coordinator.md`) for pending and rejected writes in `pr` mode. The app must work in `direct` mode without it.
  - The worker isolation request (`docs/feat-req/worker-agent-isolation.md`) for the wizard's sandbox step.
  - The independent verification request for review findings in gates. Until then, the app shows the gate without them.
- **Constraints:**
  - The kit has one runtime dependency (`yaml`), and any new one needs a reason recorded in the design.
  - Must run wherever `sdlc` runs (macOS and Linux at least), with Node only, and no separate install step beyond the kit.
  - Rendering repo markdown (design docs, specs) in a browser must not run scripts from it. Rendered content is sanitized.
  - Request bodies and error excerpts are already redacted by workers. The app must not show secrets the board doesn't already hold.

## Open Questions

- How does the app learn about new requests: polling `git fetch` on an interval (what interval?), or a GitHub webhook or notification feed?
- Frontend approach: plain HTML and JS served by Node with no build step, or a small framework with a build. This affects the kit's dependency and install story.
- How does a worker page show live logs for a running local worker (tail the log file in its home)?
- Where do PR diffs come from: links out to GitHub only, or fetched and rendered in the app with `gh`?
- Should the app also let a person release or take over a stale claim, which `sdlc` supports today?

## Solution Direction

Non-binding. A small Node `http` server in `scripts/lib/web/` that serves static assets and a JSON API mapped one-to-one onto the shared core functions. Pages for the inbox, request detail, workers, the worker wizard and board status.
