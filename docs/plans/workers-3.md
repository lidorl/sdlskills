---
feat_req: docs/feat-req/workers.md
design: docs/design/workers.md
status: IN_PROGRESS
date: 2026-11-20
plan: 3 of 3
repos: [sdlskills]
---

# Workers and the work board: Plan 3, integration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the board and workers into the kit: STATUS.md shows workers, the inbox and claims; the installer vendors `sdlc` and can scaffold `board/`; the process contract and skills claim, report and run headless; the README documents it; and one real worker run is smoke-tested.

**Architecture:** Every integration point is conditional on board mode (`board/` exists). With no `board/`, rendered output and skill behaviour stay byte-for-byte what they are today. Skills call `sdlc` for every board write, so the protocol stays in code.

**Tech Stack:** Node ≥20, Markdown skills, the existing installer (`scripts/install-sdlc.mjs`, `scripts/install-sdlc-copilot.mjs`).

**Spec:** `docs/design/workers.md` (sections: Interactive sessions, Changes to existing files, Settings, Headless mode). Depends on Plans 1 and 2.

## Global Constraints

- Everything in Plans 1 and 2's Global Constraints applies.
- Without `board/`, `docs/STATUS.md` and `docs/.status.json` are byte-identical to today's output for the same docs (apart from the generated timestamp).
- Skill and `CLAUDE.*.md` edits use `mattpocock-skills:writing-for-agents`. Skills reference `CLAUDE.process.md` sections by name, so a renamed section is a cross-file edit.
- The Copilot flavor comes from the `REWRITES` table. `npm test` must pass, with no Claude reference surviving the rewrite.
- The installer seeds `board/config.yml` only when it's absent, and never removes an existing `board/`.
- The guided question reads exactly: `Will this project run workers, or share one board across several people?` The default is No.

## Review Focus

- **Re-running the installer on a meta-root that already has a hand-edited `board/config.yml` and open requests.** Expect both to be left exactly as they were. Pinned in Task 2.
- **`render-status.mjs` in a meta-root with `board/` but no git history** (a fresh copy, or a CI checkout with depth 1). Expect the board sections rendered from files, last seen shown as `-`, and no crash. Pinned in Task 1.
- **An interactive session in a board-mode meta-root where `gh` isn't logged in.** `sdlc claim` can't resolve the login. Expect `/select-next-task` to stop with the fix (`gh auth login`), not to proceed unclaimed. Pinned in Task 4.
- **The Copilot flavor of the new skill text.** Expect `sdlc` commands and `.github/skills/...` paths, with no `Claude Code` or `.claude/` left. Pinned in Task 2.
- **A solo user who never enables the board.** Expect every skill to read exactly as today in practice: the board steps are skipped silently, with no new prompts. Pinned in Task 4.

## Repositories

| key | role | tier |
|---|---|---|
| `sdlskills` | owner | standard |

---

### Task 0: Plan 2 residuals

Added after Plan 2's final review (Ruling P2-20 in the Plan 2 ledger). The Task 6 smoke run exercises exactly these paths, so they land before integration. Each item gets a test.

**Files:**
- Modify: `scripts/lib/board/git.mjs`, `scripts/lib/board/config.mjs`
- Modify: `scripts/lib/worker/outcomes.mjs`, `scripts/lib/worker/loop.mjs`, `scripts/lib/worker/agent.mjs`, `scripts/lib/worker/salvage.mjs`
- Test: the matching `*.test.mjs` files

- [ ] **Step 1: Write the failing tests, one per item:**
  - (a) Protocol writes with a local commit ahead of origin: the `origin/main..HEAD` refusal applies only to working-tree writes. A `commitFromHead` renew succeeds while an agent commit sits in meta. `validateConfig` rejects `phase_timeout >= lease_ttl`.
  - (b) A report push that is rejected, rebased onto a newer origin feat-req, and then hits an autostash conflict: the agent's stale snapshot is salvaged, not put back. Put back only when origin's feat-req still equals the snapshot-time HEAD blob.
  - (c) A non-blocking request that landed but whose push wasn't confirmed: the next step does not post it again.
  - (d) An agent-written `Worker phase: close-out` line in a request's Context does not change answer routing. Agent lines carrying that marker are stripped, and the worker's own marker is appended and read last.
  - (e) A tracked `.Sdlc-Run/x` (case variant) is refused on a case-insensitive filesystem. The check uses the pathspec `:(icase).sdlc-run`.
  - (f) The agent checks out another branch in meta: the worker salvages the dirty files and restores `main` before any board write.
  - (g) A dirty symlink in the meta clone is salvaged as a link (`lstat` / `readlink`), never by copying its target.
- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test "scripts/lib/board/*.test.mjs" "scripts/lib/worker/*.test.mjs"`
Expected: the new tests fail.

- [ ] **Step 3: Implement (a)–(g)**
- [ ] **Step 4: Run the suites and `npm test`**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/
git commit -m "fix(worker): Plan 2 residuals — renew while ahead, safe put-back, no duplicate requests, unforgeable phase marker"
```

### Task 1: STATUS.md board view

**Files:**
- Modify: `scripts/render-status.mjs`
- Test: `scripts/render-status.test.mjs`

**Interfaces:**
- Consumes: `boardEnabled`, `loadConfig` (Plan 1, Task 2), `boardView` (Plan 1, Task 10).
- Produces: when `boardEnabled(ROOT)`, STATUS.md gains:
  - `## Workers`, grouped by owner as `### <owner>` subsections, with the table `| Worker | Name | Host | Agent / model | State | Effort | Last seen |`;
  - `## Inbox`, grouped by `for` as `### <for>`, oldest first, with the table `| Request | Kind | Effort | Age |`;
  - `Claimant | Claim age | Stale` columns on the In Progress, Planned, Designed and Accepted tables;
  - `workers` and `requests` arrays in `docs/.status.json`.
  When `git log` fails, `boardView` is called with `events: []`, and last seen shows `-`.

- [ ] **Step 1: Write the failing tests**

```js
test('no board/: STATUS.md identical to the pre-change renderer output', () => {
  // golden file captured from the current renderer before editing, timestamp line stripped
});
test('board/: Workers grouped by owner, Inbox grouped by for, claim columns with stale flag', () => {});
test('board/ without git history: renders, last seen "-"', () => {});
```

- [ ] **Step 2: Capture the golden file from the current renderer, then run the tests**

Run: `node --test scripts/render-status.test.mjs`
Expected: the golden test passes, and the two board tests fail.

- [ ] **Step 3: Add the board sections behind `boardEnabled`**

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test scripts/render-status.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/render-status.* scripts/fixtures/
git commit -m "feat(render-status): workers, inbox and claim columns in board mode"
```

### Task 2: Installer: vendor `sdlc`, `--board`, the guided question

**Files:**
- Modify: `scripts/install-sdlc.mjs` (`INSTALLER_ONLY_LIB` `:57`, package.json wiring around `:85`, docs skeleton step `:270-276`, flag parsing `:339-343`, usage `:374`)
- Modify: `scripts/lib/guide.mjs` (the question after `choosePath`, and the tree preview `:60-67`)
- Modify: `scripts/install-sdlc-copilot.mjs` (`REWRITES`, only if Step 4 finds survivors)
- Test: `scripts/install-sdlc.test.mjs`, `scripts/install-guided.test.mjs`, `scripts/install-sdlc-copilot.test.mjs`

**Interfaces:**
- Consumes: `DEFAULT_CONFIG_YAML` (Plan 1, Task 2).
- Produces:
  - `style`, `ui` and `prompter` move out of `INSTALLER_ONLY_LIB` (`sdlc` uses them). `scripts/lib/board/` and `scripts/lib/worker/` are vendored, without `fixtures.mjs` and `fixtures/`, which are test-only (tests are vendored too, so they stay in the vendored set).
  - `package.json`: `bin.sdlc = "scripts/sdlc.mjs"` is added only when `bin.sdlc` is absent.
  - `install({ ..., board: boolean })`. On `true` it creates `board/workers/.gitkeep` and `board/requests/.gitkeep`, and writes `board/config.yml` from `DEFAULT_CONFIG_YAML` when it's absent. The action line is `created board/{workers,requests}/ and board/config.yml`.
  - The `--board` flag. In the guided flow, `ui.select` asks the Global Constraints question with choices Yes / No, `initial` = No. A yes adds `├── board/  shared work board for workers` to the preview tree and `board: true` to the preview actions.

- [ ] **Step 1: Write the failing tests**

```js
test('--board scaffolds board/ and seeds config.yml', () => {});
test('no --board: no board/ directory', () => {});
test('re-run keeps a hand-edited board/config.yml and existing request files', () => {});
test('bin.sdlc added when absent, kept when present', () => {});
test('vendored scripts include sdlc.mjs, lib/board/*, lib/worker/*, lib/style.mjs, lib/ui.mjs; exclude fixtures', () => {});
test('guided: answering Yes to the workers question shows board/ and passes board: true', () => {});
test('guided: default (Enter) is No', () => {});
test('copilot layout: --board works the same; no Claude reference in vendored skills', () => {});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test scripts/install-sdlc.test.mjs scripts/install-guided.test.mjs scripts/install-sdlc-copilot.test.mjs`
Expected: the new tests fail.

- [ ] **Step 3: Implement the installer changes**

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test`
Expected: PASS. If the Copilot rewrite test reports surviving Claude references from Plan 1 or 2 strings, add `REWRITES` rules and re-run.

- [ ] **Step 5: Commit**

```bash
git add scripts/install-sdlc*.mjs scripts/install-guided.test.mjs scripts/lib/guide.mjs
git commit -m "feat(install): vendor sdlc, --board scaffold and the workers question"
```

### Task 3: Process contract

**Files:**
- Modify: `CLAUDE.process.md` (State `:101-117`, Autonomy Policy `:67-81`, a new section after "Working in the meta-root")

**Interfaces:**
- Produces three section changes that the skills in Task 4 cite by name:
  - **State**: the `claimed_by`, `claimed_at`, `renewed_at` and `awaiting` rows (board mode only); a `## Decisions` sentence (appended by the runtime when it applies answers).
  - **Autonomy Policy → "Headless mode"**: when `SDLC_HEADLESS=1`:
    - every always-hard-stop gate, and every gate set to `confirm`, `discuss` or `pause`, becomes a `request` result with `kind: gate`;
    - a need for information becomes `question`, and an assumption with a safe default becomes `clarification` (recorded in the effort's docs);
    - `task_selection` doesn't apply;
    - `technical_brainstorm: discuss` becomes a policy gate carrying the approaches as `## Options`;
    - never commit or push in the meta repo, and commit in code repos on `feat/<slug>` only;
    - write `$SDLC_RESULT_FILE` before stopping (with the JSON shape from the design).
  - **New section "Workers and the board"**: what board mode is and how it turns on; claims and leases (the one TTL rule, interactive sessions included); `sdlc claim`/`report`/`release` from skills; requests and answers; a pointer to `board/config.yml`; and the rule that no client changes lifecycle state when answering.

- [ ] **Step 1: Write the three section changes** (use `writing-for-agents`).

- [ ] **Step 2: Verify the cross-references**

Run: `grep -n "Headless mode\|Workers and the board" CLAUDE.process.md`
Expected: both headings are present.

Run: `npm test`
Expected: PASS (Copilot rewrite of the process doc).

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.process.md
git commit -m "docs(process): claim fields, headless mode, workers and the board"
```

### Task 4: Skills

**Files:**
- Modify: `skills/select-next-task/SKILL.md`
- Modify: `skills/write-design-doc/SKILL.md`, `skills/write-execution-plan/SKILL.md`, `skills/close-out/SKILL.md`
- Modify: `skills/write-feature-request/SKILL.md`, `skills/classify-change/SKILL.md`, `skills/gather-open-items/SKILL.md`, `skills/write-history-entry/SKILL.md` (only those with a gate or a status change)

**Interfaces:**
- Consumes: `sdlc next --json`, `claim`, `report --phase`, `release` (Plan 1, Task 11); the process contract sections from Task 3.
- Produces:
  - `select-next-task`:
    - drop the "Single-worker model" line;
    - "If `board/` exists" branches: Step 1 runs `node scripts/sdlc.mjs next --json` instead of reading the queue by hand (the user-override rule still applies on top);
    - Step 6, after the confirmation, runs `sdlc claim <slug>`;
    - if `sdlc` fails because `gh` isn't logged in, stop and tell the person to run `gh auth login`.
  - Every skill that sets a feat-req `status`: a closing line, "If `board/` exists, run `node scripts/sdlc.mjs report <slug> --phase <new status>`; if it exits 3, tell the person the effort was taken over and stop."
  - `close-out`: `sdlc release <slug>` after `IMPLEMENTED`.
  - Every skill with a hard stop or a policy gate: one line, "Headless (`SDLC_HEADLESS=1`): see the process contract's Headless mode."

- [ ] **Step 1: Edit the skills** (use `writing-for-agents`).

- [ ] **Step 2: Verify**

Run: `grep -rn "sdlc.mjs report\|Headless mode" skills/ | wc -l`
Expected: a non-zero count, covering every skill named in Files.

Run: `grep -n "Single-worker" skills/select-next-task/SKILL.md`
Expected: no output.

Run: `npm test`
Expected: PASS (Copilot rewrite of the skills).

- [ ] **Step 3: Commit**

```bash
git add skills/
git commit -m "feat(skills): claim and report through the board; headless gates"
```

### Task 5: README and the kit's own docs

**Files:**
- Modify: `README.md` (a new "Workers" section after Getting started)
- Modify: `CLAUDE.md` (the repo layout list: `scripts/sdlc.mjs`, `scripts/lib/board/`, `scripts/lib/worker/`)
- Modify: `docs/kit-open-items.md` (remove the promoted "Parallel agents" item, now implemented)

**Interfaces:**
- Produces a README "Workers" section covering:
  - when to use workers;
  - the prerequisites: push rights to main for every worker owner, force-push forbidden on main, `gh auth setup-git`, the agent CLI installed and logged in, and the Copilot containment note (a dedicated OS user or VM);
  - enabling the board (`--board` or the guided question);
  - `npx -p github:<org>/<meta-repo> sdlc worker create --agent claude --model <m>` on a fresh machine;
  - `start --detach`, `inbox`, `answer` and `watch`;
  - `board/config.yml`.

- [ ] **Step 1: Write the sections**
- [ ] **Step 2: Verify the links**

Run: `grep -n "sdlc worker create\|board/config.yml" README.md`
Expected: both are present.

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md docs/kit-open-items.md
git commit -m "docs: workers and the work board in README and CLAUDE.md"
```

### Task 6: Real-agent smoke run

**Files:**
- Create: `docs/history/<timestamp>_workers.md` (through `/write-history-entry`, with a Verification section)

- [ ] **Step 1: Set up a scratch meta repo**

In a temp dir: create a bare remote, install the kit into a clone with `node install-sdlc.mjs <dir> --board --skip-plugins` (the Claude installer), and add one feat-req `smoke-hello.md` (`status: ACCEPTED`, scope: "add a hello.txt to a scratch code repo"). Push.

- [ ] **Step 2: Create and run one worker**

Run: `node scripts/sdlc.mjs worker create --agent claude --model claude-haiku-5-5 --meta <bare-remote>` then `node scripts/sdlc.mjs worker once <id>`.
Expected:
- a `board(claim)` commit;
- one agent run that ends in a design-approval gate request;
- `sdlc inbox` lists the gate;
- `sdlc answer <id> --choice approve`, then `worker once` again → the effect is applied, the feat-req is `DESIGNED`, and the plan phase runs.

- [ ] **Step 3: Repeat Step 2 with `--agent copilot`, if the Copilot CLI is available.** Otherwise record "Copilot smoke skipped: CLI not available".

- [ ] **Step 4: Record the commands and outcomes in the history entry's Verification section, then commit**

```bash
git add docs/history/
git commit -m "docs(history): workers smoke run"
```

---

## Pull Requests

| key | branch | PR | state |
|---|---|---|---|
| sdlskills | feat/workers-design | #17 | draft |
