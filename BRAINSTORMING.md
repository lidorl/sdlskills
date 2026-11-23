# Brainstorming

Ideas to track, shape, and eventually implement in the kit. Larger and less-formed than [`docs/kit-open-items.md`](docs/kit-open-items.md) — that file holds specific deferred decisions from work already done; this one holds directions still being explored.

When an idea here is ready to build, it becomes a feature request under the kit's own lifecycle (or, if it's a bounded decision, an entry in `kit-open-items.md`).

---

## 1. Agent execution environment (multi-repo work) — PROMOTED

**Promoted to a feature request on 2026-09-09:** [`docs/feat-req/execution-environment.md`](docs/feat-req/execution-environment.md). Architecture agreed in a brainstorm that day (meta-root + git-ignored `workspace/`, `repos.yml` catalog + `repos/<key>.md`, repo binding as a Design output, per-repo `classify-change`, PR coordination folded into the plan, `assemble-env`/`clean-env` scripts, N=1 as the degenerate case). Remaining unknowns are in that file's Open Questions section.

Feeds / feeds from: §3 (example project is the test vehicle), §5 (repo-level docs feed the catalog), and the parallel-agents item in `kit-open-items.md`.

---

## 2. Autonomy policy that improves over time

**The problem.** The autonomy policy is defined once, at setup. But during the work the user constantly emits signals about what they actually want — "just do it", "stop asking me about X", "always run the tests first", "wait, I wanted to see that before you proceeded". None of that feeds back into the policy.

**The idea.** The agent recognizes those signals, and persists them to a memory that is always in the context of the relevant skills — so the policy sharpens with use instead of going stale.

**Open questions.**
- What counts as a signal, and how confident must the agent be before acting on one? (A frustrated one-off ≠ a durable preference.)
- Where it's stored: amendments to the autonomy block in `CLAUDE.md`? A separate learned-preferences file the skills load? The Claude Code memory system?
- Scope: per-gate, per-skill, per-phase, or global.
- Confirm-before-persist vs. silent capture with a periodic "here's what I've learned about how you want to work — keep?" review.
- Guarding against overfitting to a mood or a single bad day.
- How this interacts with re-running `setup-sdlc`.

---

## 3. Example project & testing the kit

**The problem.** There's no way to exercise the kit end to end, and no reference for what "using it well" looks like.

**The idea (two parts).**

- **An example project.** In the multi-repo world (idea 1): a small system with, say, two repos — `backend` and `frontend` — plus a repository map, wired to the kit. A guided walkthrough takes the user through one concrete feature using the full lifecycle: feature request → design → plan → development → review → close-out, producing real artifacts against real (if tiny) code.
- **Testing the kit itself.** Some way to assert the process works: run the lifecycle on the example project and check that the expected artifacts exist, are well-formed (frontmatter valid, required sections present), and that state transitions happened in order. Possibly an eval harness for individual skills.

**Open questions.**
- Scope of the example system — what does it actually do? Small enough to read in a sitting, real enough to have a meaningful feature to build.
- Does it live in this repo (`examples/`) or as separate repos the kit points at?
- How much of the walkthrough is scripted vs. genuinely agent-driven.
- Can artifact validation be a plain script (check files, parse frontmatter, verify section anchors) run in CI?
- Dogfooding: use the kit to build the kit's own features, and treat that as the primary test.

---

## 4. Extensibility — teams shape the kit to their process

**The problem.** The kit ships a fixed set of phases and skills. Every team that adopts it has process the kit doesn't cover — deployment, CI, release management, production support, incident response, compliance gates — plus team-specific conventions that belong *inside* an existing phase (a security checklist in design, a required load-test step in close-out, a house style for history entries). Today the only way to add any of that is to hand-edit skills, which adopters can't do cleanly because the skills are symlinked from this repo and updates would clobber their changes.

**The idea.** Make extension a first-class, supported operation, along two axes:

- **Extend an existing skill** — team-specific instructions, flow steps, or scripts layered onto a phase the kit already has, without forking the upstream skill. Some overlay mechanism the phase skills load (a conventional `extensions/<skill>.md`, a per-skill hook directory, a documented include point) so `superpowers` / kit upgrades don't overwrite local additions.
- **Add a new skill / phase** — a whole custom phase (deploy, CI, prod-support) that plugs into the lifecycle: appears in the State table, is routable from `select-next-task`, participates in the Definition of Done.

Plus **a new user-invoked skill** — `extend-sdlc` (name TBD) — that interviews the user about what they want to add, then recommends whether it's a new skill/phase or an extension to an existing one, and scaffolds it in the right place.

**Open questions.**
- The overlay mechanism for extending a skill: file convention, hook dir, include marker? How does the base skill discover and load the overlay?
- How a new custom phase registers with the lifecycle — does it edit `CLAUDE.process.md`'s State table and `select-next-task`'s routing, or is there a manifest of phases the kit reads?
- What `extend-sdlc` needs to know to make the new-skill-vs-extension call (does it introduce a new artifact? a new state? a new gate? or just steps within an existing phase?).
- Upgrade story: when the kit's upstream skills change, how do local extensions survive and get flagged if the extension point moved?
- Relationship to `setup-sdlc` — is `extend-sdlc` a separate skill or a re-runnable mode of setup?
- How custom phases interact with `classify-change` tiers (does a hotfix skip the deploy phase? does trivial?).
- Sharing: can one team publish its extension set for others (a deploy-phase pack), and how is that distributed?
- Guardrails so extensions don't quietly break the core invariants (state ordering, artifact lineage, Autonomy Policy).

---

## 5. Repo-level documentation & AI-readiness

**The problem.** The kit's design tree (`docs/design/architecture.md`, `data-model.md`) documents *changes* at the meta-root. But in the multi-repo world each **code repo** needs its own living documentation that makes it legible to an agent — what it does, its architecture, entry points, conventions, gotchas, how to run and test it. The catalog's `repos/<key>.md` is a *summary for selection*, not deep working docs. Today nothing in the kit defines what good repo-level AI documentation looks like, and no phase updates it — the Definition of Done only covers the meta-root's `architecture.md` / `data-model.md`, never the repo's own docs.

**The idea.**
- Define a standard for good repo-level documentation / AI preparation — likely a conventional file per repo (`AGENTS.md`, `CONTEXT.md`, or a `docs/` layout) — and what it must contain to actually help an agent plan and execute.
- The **Design** and **Plan** phases consume it, for better plans and an accurate cross-repo blast radius.
- **Development** updates it as the change alters the repo's architecture, conventions, or entry points; **Close-out** verifies it — a per-repo analogue of the meta-root `architecture.md` update. Add both to the Definition of Done. The update ships in the same PR as the change.

**Open questions.**
- What file(s), what format, what's the minimum bar? Relationship to `CLAUDE.stack.md` (meta-root, one stack) — each repo may have a different stack.
- Relationship to the catalog's `repos/<key>.md` — is the catalog note a pointer to (or excerpt of) the repo's own doc, to avoid duplication?
- When a repo has none: does the kit bootstrap it (a skill that reads the repo and drafts the doc)? This modifies someone else's repo — needs consent and a review gate.
- Ownership of updates: touch-as-you-go in Development, final sweep in Close-out, or both.
- Trust — a stale repo doc is worse than none. How does the agent know it's current?
- Adopt, don't fight: many repos already have READMEs, ADRs, `docs/`. The standard should absorb what's there.
- A "repo readiness" checklist the agent can run to score how AI-ready a repo is, and file the gaps as feature requests.
- Ties to idea 1 (catalog) and idea 3's `setup-sdlc` option D (org auto-draft reads repo docs).

---

## 6. Artifact trail vs. context budget — HIGH PRIORITY

**Priority:** high — direct, compounding effect on API cost and latency on every phase.

**The problem.** The kit produces a growing trail of markdown: `docs/feat-req/`, `docs/design/`, `docs/plans/`, `docs/history/`, plus the living `architecture.md` / `data-model.md`. Skills read and cross-reference this trail. As a project accumulates features, the tokens spent loading and reconciling it climb — and there is no mechanism that prunes, archives, summarizes, or indexes it. `STATUS.md` being derived and the phase skills being scoped help at the margin, but nothing addresses the trail itself at scale.

**What we actually know (2026-09-10 review of the skills).** The problem is narrower than "the whole trail":
- **Routine operation is already bounded.** `select-next-task` deep-reads only *non-terminal* candidates (in-flight + `ACCEPTED`); it ranks the rest on frontmatter. A single feature's lifecycle (design → plan → close-out) reads that feature's own chain. Neither scales with project age.
- **The real unbounded cost is `gather-open-items` full-sweep.** Every time the queue empties it re-scans *every* design doc's Open Items, *every* `IMPLEMENTED` plan, *every* `PARKED` feat-req — and for each loose item runs `git log` greps, reads `architecture.md` / `data-model.md`, scans `docs/history/`, sometimes the codebase. Cost grows with the whole lifetime of the project.
- **`architecture.md` / `data-model.md` grow unbounded** and are loaded on every design, plan, and close-out.
- **`docs/history/` is otherwise cold** — nothing but the full sweep routinely loads it.

So the fix targets those three things specifically, not a general archiving system.

**Two directions (pick one — 2026-09-10).**
- **(a) Full scaling spec now.** Design the complete solution as a forward-looking architectural spec — archiving, digests, an index, per-skill read contracts — and build it before the trail exists. Cost: significant design + build effort against a trail we can't yet measure; risk of over-building.
- **(b) Targeted low-cost fixes now, heavier machinery deferred.** Bound the `gather-open-items` sweep (e.g. only sweep design docs whose feature shipped within the last N months or is still referenced; skip `IMPLEMENTED` plans older than a cutoff), add explicit "what to read / what to skip" guidance to each phase skill, and add a lightweight cap or rollup discipline for `architecture.md` / `data-model.md`. Defer archiving, digests, and the index until there's real volume to measure. **Leaning here** — the kit is brand new, essentially no trail exists, and the routine path is already fine.

**The idea.** Treat the trail as something with a context budget. Candidate directions, not mutually exclusive:
- **Archive shipped artifacts out of the hot path** — once a feature is `IMPLEMENTED` and merged, move its feat-req/design/plan/history under `docs/archive/` (or tag them) so routine skill runs don't scan them.
- **Per-feature digest** — a short generated summary later phases read instead of walking the full feat-req → design → plan → history chain.
- **History rollup** — collapse `docs/history/` entries older than N months into a single digest per quarter.
- **An index the skills consult** — a manifest (feature → state → artifact paths → one-line summary) so a skill loads only what the current task needs.
- **Explicit "what to read" guidance per skill** — tell each phase skill the minimal set of files it should open, so agents stop reading whole trees "to be safe."

**Open questions.**
- Which of the above actually moves the needle — measure current token spend per phase on a trail of realistic size first.
- Archiving vs. digesting: does moving files break artifact lineage / links in `architecture.md` and history entries? Does a digest risk hiding detail a later phase genuinely needs?
- Who maintains the index/digest — a new skill, a script like `render-status.mjs`, or a step folded into `close-out`?
- Interaction with `gather-open-items` full sweep, which by design re-reads deferred items across the trail.
- Does this need per-repo treatment in the multi-repo world, where each repo may also carry its own doc trail (idea 5)?
- Trust: an archived or digested artifact that's silently stale is worse than a verbose one that's current.

Feeds from: the standing concern about artifact overload; ties to §5 (per-repo docs multiply the trail).

---

## 7. Closed-loop telemetry — post-release eval phase

**The problem.** The Feature Request phase collects success metrics (§1 of the lifecycle). `close-out` (§6) only verifies code completion and green tests. Nothing in the lifecycle ever checks whether the shipped change achieved what the feature request set out to do — the loop from "why we built it" to "did it work" is never closed.

**The idea.** A post-implementation audit phase producing `docs/eval/<name>.md`, run some agreed interval after release. It compares observed telemetry / API error rates / usage metrics against the feature request's stated success criteria, and drives a keep / iterate / revert call — filing follow-up feature requests where the change underdelivered or regressed something.

**Open questions.**
- Triggering: the kit has no runtime or scheduler. Is this a manual `/run-eval <feature>` the user invokes when they remember, a checklist item surfaced by `select-next-task` once an eval is "due," or a scheduled cloud agent?
- Data source: the kit can't read production metrics on its own. Does the adopter wire a metrics source (dashboard link, query, exported CSV) in the feature request, and the eval phase consumes whatever's there?
- Which tier requires it — standard only, or opt-in per feature based on whether §1 defined measurable metrics?
- DoD relationship: is a feature "Done" before its eval runs? Options: `IMPLEMENTED` stays terminal and eval is a separate follow-up lifecycle; or add an `EVALUATED` state and `IMPLEMENTED` becomes non-terminal.
- What happens to the eval doc's findings — straight into `gather-open-items`, or its own promotion rules?
- Autonomy policy: is the keep/iterate/revert call a hard stop?

---

## 8. Blast-radius snapshot at human gates

**The problem.** The human hard stops (design-doc approval, code/security review findings) can degrade into rubber-stamping when the reviewer is handed a full design doc or a raw diff and asked "ok?". Review fatigue erodes exactly the gates that exist for safety.

**The idea.** Before any human hard stop, the agent produces a tight **blast-radius snapshot** the human reads first: a bounded summary — on the order of five bullets covering exact changes, affected repos/services, known breakage or migration, and rollback. The full artifact stays available behind it; the snapshot is the entry point, not a replacement. Most naturally a shared sub-step the gate skills (`write-design-doc`, the review step in the process contract) call so the format is identical everywhere.

**Open questions.**
- Where it's defined: a shared skill fragment / include, or specified once in `CLAUDE.process.md` and referenced?
- Is it a section persisted in the design doc, or an ephemeral message at the gate?
- Bullet cap — hard limit or guideline? What about genuinely large changes that don't compress to five bullets (a signal the change should be split)?
- Can `/code-review` output feed the review-gate snapshot automatically?
- Does the trivial tier get a one-line version, or skip it entirely?

---

## 9. Verification-driven development as a TDD opt-out

**The problem.** The Development phase mandates TDD (via `superpowers:test-driven-development`). Strict test-first is high-friction and low-value for some domains — UI layout, infrastructure / IaC setup, third-party API wiring — where a failing red test is often contrived or meaningless. Teams in those domains either fight the rule or quietly route around it, which weakens the norm everywhere.

**The idea.** Let specific domains explicitly opt into **verification-driven development**: integration or smoke tests that prove the thing works, written alongside or immediately after the change, instead of strict test-first. Because TDD lives upstream in `superpowers`, the kit needs its own override doc that the Development phase and `close-out`'s DoD both honor.

**Open questions.**
- Granularity: per layer, per repo, per feature, per file glob?
- Who declares it — a `classify-change` output, a design-doc field, or a rule in `CLAUDE.stack.md`?
- How does `close-out`'s DoD item "tests written/updated for new/changed behavior" verify coverage under VDD without the red-green trace?
- Does this meaningfully weaken the kit's core guarantee, and what keeps a team from marking everything VDD?
- Relationship to `superpowers:verification-before-completion`, which is already a VDD-shaped step.

---

## 10. Deterministic gate enforcers — LOWER PRIORITY

**Priority:** low — the prompt layer holds well enough today. Revisit if gate-skipping shows up in real use.

**The problem.** The kit is prompt-level: it relies on Claude reading `CLAUDE.process.md` and honoring the gates. During long or messy work an agent can skip one — plan without an approved design, open a PR with an unfilled DoD checklist, transition state out of order — and nothing physically stops it.

**The idea.** Lightweight deterministic backstops that don't depend on the agent's cooperation: a git pre-push hook or CI check that fails when a feature's DoD checklist is incomplete, its state transitions are out of order, or a required artifact is missing. Advisory by default, hard-fail opt-in per adopter.

**Open questions.**
- What's cheaply checkable from artifacts alone — frontmatter state ordering, checklist boxes, artifact existence, PR/plan cross-links — vs. what needs judgment and can't be mechanized?
- Does this ship in the kit as an installable hook, or stay a documented pattern adopters wire themselves?
- Tension with "the process is the point / trust the agent": is a backstop a reasonable safety net, or an admission the prompt layer doesn't hold?
- Per-repo vs. meta-root enforcement in the multi-repo world — the DoD spans repos but hooks are per-repo.

---

## 11. Hotfix debt visibility

**The problem.** A hotfix mandates a follow-up feature request (§ tier table, DoD). That marker lives only in the markdown trail — a history entry with an Incident section, plus a new feat-req. Once the incident is mitigated the pressure is off, and the follow-up is easy to drop because nothing outside the repo's `docs/` is tracking it.

**The idea.** Make hotfix debt tracked and visible:
- Surface open hotfix follow-ups in `docs/STATUS.md` as their own section (distinct from ordinary `ACCEPTED` items) so the debt is on the dashboard until closed.
- Optionally integrate with an external tracker (Jira / Linear / GitHub Issues) so the debt lives where the team already looks — a specific instance of the external-integration capability sketched in §4.

**Open questions.**
- STATUS.md: does the follow-up FR need a distinct `incident_debt: true` flag in frontmatter, or is a convention on the reason field enough for `render-status.mjs` to pick it out?
- External tracker: kit-provided integration, or an adopter-wired hook point?
- Does `close-out` for the hotfix block on the follow-up FR file actually existing (stronger than the current DoD wording)?

---

## 12. Worker control app

**The problem.** The workers feature ([`docs/feat-req/workers.md`](docs/feat-req/workers.md)) ships a command-line client, `sdlc`. Running several detached workers from it means juggling commands, and you only learn something changed when you run `sdlc watch` or `sdlc inbox`.

**The idea.** A control app, as a terminal UI or a GUI, that is a richer client of the same board. From one place it lets you create, start, stop and retire workers, see their status live, get notified of updates, and answer questions, clarifications and approvals. Workers only speak to the board, so the app needs no worker changes.

**Open questions.**
- Terminal UI first, GUI first, or both on one shared client library?
- Where notifications come from: polling the board, a webhook on pushes to the meta repo, or GitHub notifications?
- Does it run locally only, or also as a hosted view of the board for a team?
- How does it authenticate, given the board is a git remote: reuse the user's git and `gh` credentials?

---

## 13. Slack integration for worker requests

**The problem.** Workers post requests (gates, questions, clarifications, errors) to the board ([`docs/feat-req/workers.md`](docs/feat-req/workers.md)). A person only sees them by running `sdlc inbox` or `sdlc watch`, so requests sit unanswered and workers stay blocked.

**The idea.** A Slack bridge, another client of the board, that works in both directions:
- **Out.** When a request lands on main, the bridge sends it to the person it's for in Slack, by DM or in a team channel, with its context and a link to the effort.
- **In.** The person replies in Slack, and the bridge writes the answer into the request on the board with the same pull, commit, push, validate steps. The next worker that claims the effort picks it up as usual.
- **One-tap answers.** A question's `## Options` and a gate's approve or reject become Slack buttons, so most answers are one tap. Free text in the thread covers the rest.
- **Updates.** The thread is updated when the request is answered elsewhere, withdrawn or applied, so Slack never shows a stale question.

The board stays the source of truth. Slack only mirrors requests and relays answers, and workers never talk to Slack directly.

**What the workers feature should leave room for now** (so this needs no worker changes later):
- The request record can hold external references (for example a Slack channel and thread id) and records how it was answered (`answered_via: cli | file | slack`).
- `answered_by` is always the person's GitHub login, even when a bot pushes the answer.
- Answering an already-answered request is rejected cleanly, so a late Slack reply can't overwrite a CLI answer.

**Open questions.**
- Where the bridge runs. It is the first always-on component: a small service using Slack Socket Mode, a GitHub Action on pushes to main for the outbound side, or part of the future control app?
- Identity: how a Slack user maps to a GitHub login (a mapping in the worker registry or a `people` file on the board?), and which push identity the bridge uses, with `Answered-by:` as a trailer.
- Routing: DM the owner, post to a per-team channel, or let each person choose? Where do gates for "approvers" go?
- Security: who may approve a gate from Slack, and does an approval need a confirmation step? Error excerpts are already redacted, but are they safe to post in a shared channel?
- Follow-ups: if a person asks a question back in the thread, how does that reach a worker? Is it a new request in the other direction?
- Relationship to the GitHub-issues option for requests: would Slack replace it, or sit on top of it?
- Other chat tools (Teams, Google Chat): should the bridge be one adapter behind a generic interface?

---

## 14. A GitHub workflow as the claim arbiter

**The problem.** In the workers design ([`docs/design/workers.md`](docs/design/workers.md)), claims race on main: every worker pushes straight to main, the loser's push is rejected, and it has to re-validate and start over. This makes the protocol depend on careful client-side steps (pull, commit, push, validate) in every client. It also forces adopters to allow direct pushes to main, so main can't be protected by required PRs.

**The idea.** A worker never pushes a claim to main. Instead:
- **Submit.** The worker opens a PR that changes only the claim fields of one feat-req.
- **Arbitrate.** A GitHub workflow reviews the PR against the board on main (only claim fields changed, no live claim on the effort, not `awaiting` an open request, the worker registered and not retired), then approves and merges it, or closes it with a reason.
- **Serialize.** The workflow runs with `concurrency: 1` (one group, no cancel-in-progress), so claims are decided one at a time and the race disappears by construction.
- **Wait.** The worker waits for the PR to change state. Merged means the claim holds. Closed means it starts over and picks something else.

In practice the workflow becomes the work manager: the single place that decides who holds what, while workers stay pull-based.

**Trade-offs to weigh.**
- **Gains.** No client-side race logic, so claim validation lives in one place. Main can be protected (only the workflow merges), which removes the workers feature's biggest adoption constraint. Every claim gets an auditable PR record.
- **Costs.** Claim latency goes from one push to a workflow run (tens of seconds to minutes). It depends on GitHub Actions minutes and availability: if Actions is down, nobody can claim. It ties the protocol to GitHub (the workers feature is already GitHub-only). PRs per claim add noise to the meta repo.
- **Scope creep risk.** Once a workflow arbitrates claims, it's tempting to route reports, takeovers, releases and requests through it too. That would make it a central dispatcher, which the workers feature put out of scope.

**Open questions.**
- Claims only, or also takeovers and releases? Reports probably stay direct pushes (they only touch the effort's own files), but then main still needs direct pushes for reports.
- How does the worker wait: poll `gh pr view`, or `gh pr checks --watch`? What timeout, and what happens if the workflow never runs?
- Does `concurrency: 1` queue fairly under load, or does GitHub drop pending runs? (A concurrency group keeps only one pending run and cancels older pending ones, so a queue of many claims may need a different mechanism, such as a merge queue.)
- Is GitHub's merge queue a better fit than a custom workflow, since it already serializes merges and re-checks each PR against the latest main?
- How does an interactive session claim: also through a PR, with the person waiting for it?
- Could it run alongside direct-push claims during migration, or is it all or nothing per meta repo?

---

## 15. Project-wide "stop all work" switch

**The problem.** In the workers design ([`docs/design/workers.md`](docs/design/workers.md)), each worker is stopped one at a time, by its owner, on the machine it runs on (`sdlc worker stop`). Nothing stops every worker at once. A team that hits a bad merge, a broken main, a runaway cost or an incident has no way to say "everyone stop now". It would have to reach every owner and every machine.

**The idea.** A project-level switch on the board that every worker honors:
- **Set.** `sdlc board pause [--reason "..."]` commits a flag to main, for example `board/control.yml` with `paused: true`, a reason, and who set it and when. `sdlc board resume` clears it.
- **Honor.** Each worker checks the flag at every point where it already pulls: before claiming, before every report and on every idle poll. When it's set, the worker takes no new work.
- **Visible.** `sdlc status`, `sdlc watch` and STATUS.md show the board as paused, with the reason and who paused it.

Because the flag lives on the board, it reaches every worker on every machine with no new channel, the same way gates and answers do.

**Decisions to make.**
- **Soft or hard stop.** Soft: finish the current phase, report, release and idle. Hard: kill the agent run at once, report what exists and release. Maybe both, as `pause` and `pause --now`.
- **What "stopped" means for the worker process.** It could stay running and idle, polling until resumed, or exit as if `sdlc worker stop` had been run. Idling resumes on its own, while exiting needs every owner to restart.
- **Interactive sessions.** Does the flag block `sdlc claim` and `report` too, or only workers?
- **Latency.** A worker inside a long agent run only notices the flag at its next pull. A hard stop would need the runtime to poll the board during runs (it already renews leases every TTL/2, which could be the check point).
- **Scope.** Whole board only, or also per effort and per owner (`sdlc board pause --effort bulk-export`, `--owner lidorl`)?
- **Who may pause or resume.** Anyone with push rights (consistent with gates having no access control), or a restricted list?
- **Relation to §14.** If a workflow arbitrates claims, it could refuse every claim PR while paused, and workers wouldn't need to check the flag themselves.
