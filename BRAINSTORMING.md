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
