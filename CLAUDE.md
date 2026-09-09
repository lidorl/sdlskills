# CLAUDE.md

Guidance for Claude Code when working **on this repo** (the SDLC kit itself).

## What this repo is

A reusable, artifact-driven SDLC process for Claude Code plus the skills that implement each phase. This repo contains **no application code** — it is process + tooling only.

- [`CLAUDE.process.md`](CLAUDE.process.md) — the stack-neutral process contract. This is the deliverable: adopters drop it into their project.
- [`CLAUDE.stack.example.md`](CLAUDE.stack.example.md) — a worked example of the stack-conventions half (NestJS/Prisma/React). Adopters replace it wholesale.
- [`skills/`](skills/) — the phase skills (see table below).
- [`scripts/render-status.mjs`](scripts/render-status.mjs) — derives `docs/STATUS.md` from feature-request frontmatter.
- [`examples/react-components/`](examples/react-components/) — optional React admin-console conventions skill.
- [`BRAINSTORMING.md`](BRAINSTORMING.md) — larger, less-formed ideas being explored for the kit.
- [`docs/kit-open-items.md`](docs/kit-open-items.md) — specific deferred design decisions from work already done.
- [`site/index.html`](site/index.html) — the landing page (self-contained; not yet wired to GitHub Pages).

## Working on the kit

When editing a skill or either `CLAUDE.*.md`, use `mattpocock-skills:writing-for-agents`. Keep the process contract and the skills in sync — the skills reference `CLAUDE.process.md` sections by name (Autonomy Policy, State table, Definition of Done), so a rename there is a cross-file edit.

The kit's own open questions go in [`docs/kit-open-items.md`](docs/kit-open-items.md) (bounded, deferred decisions) or [`BRAINSTORMING.md`](BRAINSTORMING.md) (larger directions still being shaped) — not inline TODOs.

## Skills in this repo

| Skill | Phase |
|---|---|
| [`setup-sdlc`](skills/setup-sdlc/) | One-time adoption: map repo, adapt stack doc, autonomy interview, bootstrap `docs/design/` |
| [`write-feature-request`](skills/write-feature-request/) | Feature Request — product interview + spec + triage |
| [`classify-change`](skills/classify-change/) | Tier decision (trivial / standard / hotfix) before any code |
| [`write-design-doc`](skills/write-design-doc/) | Design — design doc with fixed structure |
| [`write-execution-plan`](skills/write-execution-plan/) | Plan — wraps `superpowers:writing-plans`, stamps state |
| [`write-history-entry`](skills/write-history-entry/) | Development — execution trace |
| [`select-next-task`](skills/select-next-task/) | Picks + routes the next task by phase |
| [`gather-open-items`](skills/gather-open-items/) | Reconciles Open Items (scoped + full sweep) |
| [`close-out`](skills/close-out/) | Definition-of-Done walk + status flip + doc updates |

External dependencies: `superpowers` plugin (`writing-plans`, `brainstorming`, `executing-plans`, `subagent-driven-development`, `receiving-code-review`, `verification-before-completion`); `/code-review` and `/security-review` (built in).

## Adopting the kit in a project

1. Enable the `superpowers` plugin:
   ```
   /plugin marketplace add claude-plugins-official
   /plugin install superpowers@claude-plugins-official
   ```
2. Copy `CLAUDE.process.md` into the target repo. Create a `CLAUDE.stack.md` for the actual stack (start from `CLAUDE.stack.example.md`). Reference both from the project's `CLAUDE.md`.
3. Symlink the skills:
   ```bash
   mkdir -p .claude/skills
   for s in setup-sdlc write-feature-request classify-change write-design-doc \
            write-execution-plan write-history-entry select-next-task \
            gather-open-items close-out; do
     ln -s /path/to/sdlskills/skills/$s .claude/skills/$s
   done
   cp /path/to/sdlskills/scripts/render-status.mjs scripts/
   ```
4. Run `/setup-sdlc` and follow the interview.
5. Start the loop: `/write-feature-request`, then `/select-next-task`.
