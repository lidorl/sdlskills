# CLAUDE.md

Guidance for Claude Code when working **on this repo** (the SDLC kit itself).

## What this repo is

A reusable, artifact-driven SDLC process for Claude Code plus the skills that implement each phase. This repo contains **no application code** — it is process + tooling only.

- [`CLAUDE.process.md`](CLAUDE.process.md) — the stack-neutral process contract. This is the deliverable: adopters drop it into their project.
- [`CLAUDE.stack.example.md`](CLAUDE.stack.example.md) — a worked example of the stack-conventions half (NestJS/Prisma/React). Adopters replace it wholesale.
- [`skills/`](skills/) — the phase skills (see table below).
- [`scripts/install-sdlc.mjs`](scripts/install-sdlc.mjs) — scaffolds the kit into a target project (vendors skills, copies scripts, docs skeleton, plugin, `package.json` / `.gitignore` wiring). See "Adopting the kit" below.
- [`scripts/render-status.mjs`](scripts/render-status.mjs) — derives `docs/STATUS.md` from feature-request frontmatter.
- [`scripts/assemble-env.mjs`](scripts/assemble-env.mjs) / [`clean-env.mjs`](scripts/clean-env.mjs) — reconstruct / tear down `workspace/` for a multi-repo effort.
- [`repos.yml`](repos.yml) / [`repos/`](repos/) — the repository catalog (multi-repo execution environment). [`repos.example.yml`](repos.example.yml) is the template.
- [`examples/react-components/`](examples/react-components/) — optional React admin-console conventions skill.
- [`BRAINSTORMING.md`](BRAINSTORMING.md) — larger, less-formed ideas being explored for the kit.
- [`docs/kit-open-items.md`](docs/kit-open-items.md) — specific deferred design decisions from work already done.
- [`site/index.html`](site/index.html) — the landing page (self-contained). Deployed to GitHub Pages by [`.github/workflows/deploy-site.yml`](.github/workflows/deploy-site.yml) on push to `main` touching `site/**`. Requires repo **Settings → Pages → Source = "GitHub Actions"** (one-time).

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

Run the installer against the target repo. It vendors the phase skills into `.claude/skills/`, copies the scripts, drops in `CLAUDE.process.md`, seeds `CLAUDE.stack.md` and `repos.example.yml`, wires `package.json` and `.gitignore`, builds the `docs/` skeleton, and installs the `superpowers` plugin:

```bash
node /path/to/sdlskills/scripts/install-sdlc.mjs <target-dir>
```

`--dry-run` previews the changes; `--skip-plugins` / `--skip-npm` opt out of those steps. Re-running updates the vendored skills and scripts in place and leaves your `CLAUDE.stack.md`, `package.json`, and `.gitignore` edits alone.

Then, in the target:

1. Reference `CLAUDE.process.md` and `CLAUDE.stack.md` from its `CLAUDE.md`, and adapt `CLAUDE.stack.md` to the real stack.
2. Run `/setup-sdlc` — maps the repo, builds `repos.yml`, runs the autonomy interview.
3. Start the loop: `/write-feature-request`, then `/select-next-task`.
