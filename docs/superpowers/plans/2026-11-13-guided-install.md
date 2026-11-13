# Guided Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** First-time adopters get a guided installer (prerequisite check, meta-root explanation, code-repo warning, plan + confirmation, clear summary) and a README that explains the same things.

**Architecture:** Four small helpers in `scripts/lib/` (`prereqs`, `code-repo`, `report`, `guide`), each unit-tested with injected dependencies. `main()` in `install-sdlc.mjs` picks the mode: no argument on a TTY runs the guide; an argument keeps today's non-interactive flow plus warnings. Both installers share `main`, so Copilot gets it through the layout object.

**Tech Stack:** Node 20+, built-ins only (`node:readline/promises`, `node:test`). No dependencies: the installer runs before `npm install` in the target.

**Spec:** [docs/superpowers/specs/2026-11-13-guided-install-design.md](../specs/2026-11-13-guided-install-design.md)

## Global Constraints

- Zero dependencies; Node built-ins only.
- Node 20 or newer is the stated floor.
- Passing a `<target-dir>` argument never prompts and never blocks; exit codes and files written are unchanged.
- No argument and no TTY: print usage and exit 1.
- No `--yes` flag.
- Default install folder: sibling `<name>-workspace` (e.g. `acme-api` -> `acme-api-workspace`).
- User-facing text introduces the term once as "your SDLC repo (the *meta-root*)", then uses the plain name; `CLAUDE.process.md` and skills keep saying meta-root.
- `scripts/` is copied wholesale into adopters (except `install-sdlc*`); helpers live in `scripts/lib/`.
- Installer wording for Copilot must say Copilot, not Claude Code (use `layout.toolName`).
- `npm test` must stay green, including the Copilot rewrite test.

## Review Focus

- Path with spaces or a relative path typed at the install-location prompt: resolved against `cwd`, works.
- Ctrl-D / closed input in the middle of a prompt: the guide aborts cleanly (returns `null`), no stack trace, no hang.
- Windows `.cmd` shims (`claude.cmd`, `copilot.cmd`): the CLI probe and the plugin install find them. Today's `cliAvailable` and `execFileSync(cli, ...)` fail on them.
- `--dry-run` in the guided flow: nothing is created, including the target folder.
- No argument and not a TTY (CI, pipes): usage and exit 1, never a hang.

---

### Task 1: Prerequisite check and layout fields

**Files:**
- Create: `scripts/lib/prereqs.mjs`
- Create: `scripts/lib/prereqs.test.mjs`
- Modify: `scripts/install-sdlc.mjs` (`CLAUDE_LAYOUT`, `cliAvailable`, plugin install in step 7)
- Modify: `scripts/install-sdlc-copilot.mjs` (`COPILOT_LAYOUT`)

**Interfaces:**
- Produces:
  - `commandAvailable(cmd: string, opts?: { exec?: typeof execFileSync; platform?: string }): boolean` — runs `cmd --version`; on `win32` runs it through a shell so `.cmd` shims resolve.
  - `runCli(cmd: string, args: string[], opts?: { exec?; platform?; stdio?: string }): void` — same Windows handling, used for the plugin install.
  - `checkPrereqs({ layout, nodeVersion?: string, available?: (cmd: string) => boolean }): Prereq[]`
  - `type Prereq = { id: 'node' | 'git' | 'tool-cli' | 'gh'; label: string; ok: boolean; required: boolean; fix: string }`
  - New layout fields: `toolName: string` (`'Claude Code'` / `'GitHub Copilot'`), `cliRequired: boolean` (`true` / `false`), `otherInstaller: string` (`'install-sdlc-copilot.mjs'` / `'install-sdlc.mjs'`).

- [ ] **Step 1: Write the failing tests** in `scripts/lib/prereqs.test.mjs`. Names and assertions:
  - `node 18 is missing and required`: `checkPrereqs({ layout: CLAUDE_LAYOUT, nodeVersion: '18.19.0', available: () => true })` has `{ id: 'node', ok: false, required: true }` and its `fix` mentions `nodejs.org`.
  - `node 20 is ok`: same with `'20.0.0'` gives `ok: true`.
  - `git missing is required`: `available: (c) => c !== 'git'` gives `git` `{ ok: false, required: true }`.
  - `claude CLI is required for the Claude layout, optional for Copilot`: with `available: (c) => c !== layout.plugin.cli`, `tool-cli` has `required: true` for `CLAUDE_LAYOUT` and `required: false` for `COPILOT_LAYOUT`.
  - `gh is optional`: `available: (c) => c !== 'gh'` gives `gh` `{ ok: false, required: false }`.
  - `commandAvailable uses a shell on win32 only`: with an `exec` stub recording its options, `platform: 'win32'` passes `shell: true`; `platform: 'linux'` does not. A throwing stub returns `false`.
- [ ] **Step 2: Run** `node --test scripts/lib/prereqs.test.mjs`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `commandAvailable`, `runCli`, `checkPrereqs` in `scripts/lib/prereqs.mjs`. Labels name the tool via `layout.toolName`. `fix` strings: node -> "Install Node 20 or newer from https://nodejs.org"; git -> "Install git from https://git-scm.com"; tool CLI -> the install pointer for that tool; gh -> "Install the GitHub CLI from https://cli.github.com (needed at close-out to verify merged PRs)". On `win32` with args, avoid Node's DEP0190 warning (shell with an args array) by joining the command into one string for `exec`.
- [ ] **Step 4: Add the three layout fields** to `CLAUDE_LAYOUT` and `COPILOT_LAYOUT`; replace `cliAvailable` in `install-sdlc.mjs` with `commandAvailable` and the `execFileSync(cli, c, ...)` plugin install with `runCli(cli, c, { stdio: 'inherit' })`.
- [ ] **Step 5: Run** `npm test`. Expected: all pass, including the new tests.
- [ ] **Step 6: Commit** `feat(install): prerequisite check and Windows-safe CLI calls`.

### Task 2: Code-repo detection

**Files:**
- Create: `scripts/lib/code-repo.mjs`
- Create: `scripts/lib/code-repo.test.mjs`

**Interfaces:**
- Produces: `looksLikeCodeRepo(dir: string): { isCode: boolean; reason: string }` — `reason` is `''` when `isCode` is false, otherwise a short phrase such as "has a src/ folder" or "has go.mod".

- [ ] **Step 1: Write the failing tests** using temp dirs (`mkdtempSync`), each `git init`-ed unless stated. Names and assertions:
  - `plain git repo with src/ is code`: `src/` present -> `isCode: true`, `reason` matches `/src/`. Same for `app/` and `lib/`.
  - `build manifests are code`: each of `pyproject.toml`, `go.mod`, `pom.xml`, `Cargo.toml`, `App.csproj` -> `isCode: true`.
  - `package.json with dependencies beyond yaml is code`: `{"dependencies":{"express":"^4"}}` -> true; `{"dependencies":{"yaml":"^2.5.0"}}` -> false; no dependencies -> false.
  - `not a git repo is never flagged`: `src/` present but no `.git` -> `isCode: false`.
  - `a directory that already holds the kit is never flagged`: git repo with `src/` and `.claude/skills/write-design-doc/SKILL.md` -> false; same with `.github/skills/write-design-doc/SKILL.md`.
  - `empty git repo is not code`.
- [ ] **Step 2: Run** `node --test scripts/lib/code-repo.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement `looksLikeCodeRepo`** per the spec's rule. Order: kit-installed check first, then git check, then signals.
- [ ] **Step 4: Run** the file. Expected: PASS.
- [ ] **Step 5: Commit** `feat(install): detect when the install target looks like a code repo`.

### Task 3: Report formatting

**Files:**
- Create: `scripts/lib/report.mjs`
- Create: `scripts/lib/report.test.mjs`
- Modify: `scripts/install-sdlc.mjs` (the three `console.log` blocks at the end of `main`)

**Interfaces:**
- Produces: `formatReport({ title: string, actions: string[], warnings: string[], nextSteps: string[] }): string` with three blocks: `Done`, `Needs attention` (omitted when no warnings), `Next steps` (numbered `1.`, `2.`, ...).

- [ ] **Step 1: Write the failing tests.** `numbers next steps from 1`: output contains `1. ` and `2. ` lines in order. `omits Needs attention when there are no warnings`. `lists every action under Done`. `puts warnings under Needs attention`.
- [ ] **Step 2: Run** `node --test scripts/lib/report.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement `formatReport`.**
- [ ] **Step 4: Replace** the final logging in `main` with `console.log(formatReport({ title: layout.installer.replace(/\.mjs$/, ''), ...r }))`.
- [ ] **Step 5: Run** `npm test`. Expected: pass.
- [ ] **Step 6: Commit** `feat(install): clearer end-of-run summary`.

### Task 4: The guided flow

**Files:**
- Create: `scripts/lib/guide.mjs`
- Create: `scripts/lib/guide.test.mjs`

**Interfaces:**
- Consumes: `checkPrereqs`, `looksLikeCodeRepo`, layout fields from Tasks 1-2.
- Produces: `runGuide({ layout, cwd: string, input: Readable, output: Writable, available?: (cmd: string) => boolean, nodeVersion?: string, dryRun?: boolean, preview: (targetDir: string) => string[] }): Promise<string | null>` — resolves to the absolute target directory, or `null` if the user quit, a required prerequisite is missing, or input closed. When `dryRun` is true it never creates a directory.

Flow (per spec): explain meta-root with a folder diagram -> say which tool this installer is for and print `node scripts/${layout.otherInstaller}` for the other -> prerequisites (stop on a missing required one, printing its `fix`) -> ask install path (default `join(dirname(cwd), basename(cwd) + '-workspace')`; empty answer accepts the default; relative paths resolve against `cwd`) -> code-repo check (offer continue / choose another path / quit) -> show `preview(target)` and ask to proceed -> create the folder if missing (unless `dryRun`) -> return.

- [ ] **Step 1: Write the failing tests.** Drive the guide with `PassThrough` input written line by line and capture `output`. Use a fixture `cwd` inside a temp dir. Names and assertions:
  - `explains the meta-root and names the tool`: output contains `meta-root` and `GitHub Copilot` (Copilot layout) and `install-sdlc.mjs` (the other installer).
  - `stops when a required prerequisite is missing`: `available: (c) => c !== 'git'` -> resolves `null`, output contains git's `fix`.
  - `continues when only optional prerequisites are missing`: `gh` unavailable, answers accept defaults -> resolves a path.
  - `empty answer accepts the <name>-workspace default and creates it`: `cwd` = `<tmp>/acme-api`; answers `''`, `'y'` -> resolves `<tmp>/acme-api-workspace`, which now exists.
  - `relative and spaced paths resolve against cwd`: answer `my space/meta` -> resolves `join(cwd, 'my space/meta')`.
  - `warns on a code repo and lets the user pick another path`: first path is a git repo with `src/`; answers `'another'`, then a clean path, then `'y'` -> resolves the clean path; output contains the warning reason.
  - `quitting at the code-repo warning returns null and creates nothing`.
  - `declining the plan returns null`.
  - `dryRun creates no directory`: accepted path does not exist afterwards.
  - `closed input mid-prompt resolves null without throwing`: `input.end()` after the first prompt.
- [ ] **Step 2: Run** `node --test scripts/lib/guide.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement `runGuide`** using `node:readline/promises`. Wrap `question` so a readline `close` event settles the pending prompt (a pending `question` otherwise never resolves when input ends); treat that as abort.
- [ ] **Step 4: Run** the file. Expected: PASS.
- [ ] **Step 5: Commit** `feat(install): interactive guided flow`.

### Task 5: Wire it into the installers

**Files:**
- Modify: `scripts/install-sdlc.mjs` (`install` target check, `main`, entry line)
- Modify: `scripts/install-sdlc-copilot.mjs` (entry line)
- Create: `scripts/install-guided.test.mjs`

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: `main(layout?): Promise<void>` (now async). `install()` with `dryRun: true` no longer throws when `targetDir` is missing (non-dry-run still throws, so the existing test holds).

- [ ] **Step 1: Write the failing tests** in `scripts/install-guided.test.mjs`, spawning the real scripts with `execFileSync`/`spawnSync`:
  - `no argument and no TTY prints usage and exits 1` for both `install-sdlc.mjs` and `install-sdlc-copilot.mjs` (spawned with piped stdio, which is non-TTY); stderr contains `usage`; must return within the test timeout.
  - `an argument stays non-interactive and prints Done and Next steps`: spawn with a temp target and `--skip-plugins --skip-npm`; exit 0; stdout contains `Done` and `Next steps`.
  - `an argument pointing at a code repo warns but still installs`: target is a git repo with `src/`; stdout contains `Needs attention`; the skills directory exists afterwards.
  - `install dry-run tolerates a missing target`: `install({ ..., targetDir: join(tmp, 'nope'), dryRun: true })` does not throw and creates nothing; the same call without `dryRun` throws.
- [ ] **Step 2: Run** `node --test scripts/install-guided.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Relax the target check** in `install` to `if (!dryRun && !existsSync(targetDir))`.
- [ ] **Step 4: Rewrite `main`**: with a `<target-dir>` argument, run `checkPrereqs` and `looksLikeCodeRepo` and add missing prerequisites and the code-repo reason to `warnings` (never prompt or block), then `install` and print `formatReport`. With no argument: if `process.stdin.isTTY && process.stdout.isTTY`, call `runGuide` (passing `preview: (t) => install({ ..., targetDir: t, dryRun: true }).actions`, and `dryRun` from the flags), exit quietly on `null`, else install and print the report; if not a TTY, print the existing usage to stderr and exit 1. Make the entry lines `if (isEntryPoint(import.meta.url)) await main()` / `await main(COPILOT_LAYOUT)`.
- [ ] **Step 5: Run** `npm test`. Expected: all pass.
- [ ] **Step 6: Manual check** in a terminal: `node scripts/install-sdlc.mjs` (guided), `node scripts/install-sdlc-copilot.mjs --dry-run` (guided, nothing created), and `node scripts/install-sdlc.mjs <tmp-dir> --skip-plugins --skip-npm`. Confirm the wording reads clearly for a first-time user.
- [ ] **Step 7: Commit** `feat(install): guided mode when run without a target`.

### Task 6: README and docs

**Files:**
- Modify: `README.md` ("Using it in a project")
- Modify: `CLAUDE.md` ("Adopting the kit in a project")
- Modify: `site/index.html` only if it repeats the install steps

**Interfaces:**
- Consumes: the installer's final wording from Task 5 (the sample output in the README must match it).

- [ ] **Step 1: Rewrite "Using it in a project"** with these sections, in order: *Before you start* (prerequisites table: Node 20+, git required; Claude Code CLI or Copilot (CLI optional for VS Code), GitHub CLI optional, with why each), *What's a meta-root* (concept in plain words; "install here, not in your code repo"; a folder diagram showing `acme-api-workspace/` containing `docs/`, `.claude/skills/` and the separate `workspace/acme-api/` checkouts folder, labelled so the two "workspace" names are not confused), *Install* (one command each for Claude Code and Copilot; no arguments starts the guided flow; the flags), *What you'll see* (abbreviated real output pasted from Task 5's manual run), *After install* (numbered next steps matching the installer), *Troubleshooting* (installed into a code repo by mistake and how to undo it; a missing prerequisite; Windows notes).
- [ ] **Step 2: Update `CLAUDE.md`'s adoption section** to mention the guided flow in one sentence and link to the README section.
- [ ] **Step 3: Check `site/index.html`** with `grep -n "install-sdlc" site/index.html`; update only copy that now contradicts the README.
- [ ] **Step 4: Verify** every command in the README by running it (`--dry-run` is enough) and that `npm test` is green.
- [ ] **Step 5: Commit** `docs: first-time install guide in the README`.
