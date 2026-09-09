---
name: setup-sdlc
description: Use once per project when adopting the SDLC kit — verifies dependencies, maps the repo into a stack-conventions doc, builds the repository catalog, runs the autonomy interview, and optionally bootstraps docs/design/. Run before the first feature.
---

One-time adoption. Produces: a project `CLAUDE.stack.md`, `repos.yml` (the repository catalog), the Autonomy Policy block in `CLAUDE.md`, the `docs/` skeleton, and (if the user opts in) initial `architecture.md` / `data-model.md`.

### Step 1: Verify dependencies

- `superpowers` plugin installed (`writing-plans`, `brainstorming`, `executing-plans`, `subagent-driven-development`, `receiving-code-review`, `verification-before-completion` resolve).
- `/code-review` and `/security-review` resolve.
- Kit skills present in `.claude/skills/` (vendored by `install-sdlc.mjs`): `write-feature-request`, `classify-change`, `write-design-doc`, `write-execution-plan`, `write-history-entry`, `select-next-task`, `gather-open-items`, `close-out`.
- `scripts/render-status.mjs`, `scripts/assemble-env.mjs`, `scripts/clean-env.mjs`, `scripts/lib/catalog.mjs` present.
- `package.json` with `yaml` in `dependencies`; `node` and `npm` available.
- `CLAUDE.process.md` present and referenced from `CLAUDE.md`.

Report anything missing with the fix command. Do not continue until resolved.

### Step 2: Create the docs skeleton

```
docs/feat-req/  docs/design/  docs/plans/  docs/history/  docs/decisions/
```

### Step 3: Map the repo

Build an accurate picture of the codebase — this feeds the stack doc and the bootstrap decision:

1. **Entry points & run commands** — read `package.json`/`Makefile`/`pyproject.toml`/etc. Record the real dev, build, test, and DB commands.
2. **Language & framework** — versions, module system, strictness settings.
3. **Layering** — trace one request/operation end to end. Name the layers and the rule for what goes in each.
4. **Module/directory convention** — how a new resource or feature is structured.
5. **Validation & error handling** — the shared pattern.
6. **AuthN/AuthZ** — every guard/middleware and what it protects. This becomes the Security Review trigger list.
7. **Data layer** — ORM/query approach, migration tooling, key schema invariants.
8. **Config** — how env vars are accessed, which are required.
9. **UI** — if there's a frontend, its stack and whether a `STYLE_GUIDE.md` exists.
10. **Tests** — framework, unit vs integration split, where tests live, how they run.

### Step 4: Write `CLAUDE.stack.md`

Use `CLAUDE.stack.example.md` from the kit as the shape. Fill every section from Step 3's findings. Delete sections that don't apply (e.g. no UI). Put the real Security Review trigger list in it. Reference it from `CLAUDE.md`.

### Step 5: Build the repository catalog

The kit works across repositories. `repos.yml` at the meta-root maps them — which repo does what — so the Design phase can resolve which repos an effort touches. See `repos.example.yml` for the annotated shape.

1. **List the repos.** Ask the user for every repo the project works across. For each, gather: `key` (short handle, used as the repo id everywhere), `url`, `default_branch`, `domain` (backend/frontend/infra/shared-lib/service/…), a `summary` paragraph (what it is, what lives in it), `responsibilities` (bullets — what it owns), `depends_on` (other keys it integrates with), `keywords` (match hints).
2. **N=1 shortcut.** If the user names only one repo, fetch its README and draft the single entry yourself; confirm once.
3. **Write `repos.yml`.** For any repo the user wants to elaborate, create `repos/<key>.md` from the template in `repos/README.md` and set `notes: true`.
4. **Validate.** Run:
   ```
   node -e "import('./scripts/lib/catalog.mjs').then(m => m.loadCatalog(process.cwd())).then(c => console.log('ok:', Object.keys(c.repos)))"
   ```
   Fix every reported problem before continuing.

### Step 6: Meta-root wiring

- Run `npm install` (installs `yaml`).
- Ensure `.gitignore` contains `workspace/` and `node_modules/`.
- `workspace/` is created on demand by `assemble-env.mjs` — do not create it now.

### Step 7: Autonomy interview

Ask each of these with a concrete example. Record answers in the Autonomy Policy block in `CLAUDE.md`.

1. **Task selection** — "When `/select-next-task` picks the next thing to work on, should it stop and ask you first, or just start? Example: it ranks a High-priority bug above a Medium feature and begins the bug." → `task_selection: confirm | auto`
2. **Product brainstorm** — "When intaking a feature, should the agent discuss the product shape with you (personas, scenarios, scope), or spec it solo from your initial description and let you review the written spec? Example: you say 'add saved searches' and the agent either asks you 10 questions or writes the spec with assumptions listed." → `product_brainstorm: discuss | solo`
3. **Technical brainstorm** — "When the design has a real fork (e.g. audit table vs. event log), discuss the options with you, or pick one with written rationale and show you in the design doc? The design doc still needs your approval either way." → `technical_brainstorm: discuss | solo`
4. **Implementation checkpoints** — "During implementation, pause between plan phases for you to review progress, or run straight through and show you the result plus the history entry? Example: a 6-phase plan stops 5 times, or once at the end." → `implementation_checkpoints: pause | run-through`

State clearly: design-doc approval, feature-request triage, and code/security review findings are **always** hard stops regardless of these answers.

Write the block:

```yaml
autonomy:
  task_selection: <answer>
  product_brainstorm: <answer>
  technical_brainstorm: <answer>
  implementation_checkpoints: <answer>
```

### Step 8: Bootstrap decision (user's call)

Ask: "Generate initial `docs/design/architecture.md` and `docs/design/data-model.md` now from the repo mapping, or let them build up lazily as features touch each area?"

- **Bootstrap** → write both from Step 3's findings. Mark them "generated by setup-sdlc, needs review" and ask the user to correct. If there's a UI and no `STYLE_GUIDE.md`, offer to draft one from `STYLE_GUIDE.template.md`.
- **Lazy** → skip. `/write-design-doc` creates each file with the relevant slice the first time a feature touches that area.

### Step 9: Finish

- Run `scripts/render-status.mjs` to create the initial `docs/STATUS.md`.
- Confirm the `Stop` hook for `render-status.mjs` is in `.claude/settings.json` (add it if not).
- Tell the user: start with `/write-feature-request`, then `/select-next-task`.

### Constraints

- Do not guess the stack — read the code (Step 3). A wrong `CLAUDE.stack.md` misroutes every subsequent feature.
- The bootstrap decision is the user's, not the agent's.
- `repos.yml` must validate (Step 5.4) before the interview continues.
- Re-running this skill re-runs the interview and regenerates `CLAUDE.stack.md`; it does not overwrite hand-edits to the Autonomy Policy or `repos.yml` without confirming.
