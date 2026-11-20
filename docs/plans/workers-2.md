---
feat_req: docs/feat-req/workers.md
design: docs/design/workers.md
status: IN_PROGRESS
date: 2026-11-20
plan: 2 of 3
repos: [sdlskills]
---

# Workers and the work board: Plan 2, the worker runtime

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship persistent workers: `sdlc worker create | start [--detach] | once | stop | status | list | retire | config`, and a loop that claims work, runs Claude Code or Copilot headless per phase, and reports to the board built in Plan 1.

**Architecture:** A worker is a home folder (`~/.sdlc/workers/<id>/`) holding its own meta repo clone, config, local state, pid file and logs. The loop is a single `step()` function with every effect injected (agent runner, clock, sleep, `gh`), so tests drive it with a fake agent and a bare remote. Only the runtime writes to the board. The agent edits files and writes `$SDLC_RESULT_FILE`.

**Tech Stack:** Node ≥20, `node:child_process` (spawn, detached), `yaml`, `git`, `gh`, `claude` / `copilot` CLIs.

**Spec:** `docs/design/workers.md` (sections: Worker home and lifecycle, The worker loop, Headless agent invocation). Depends on Plan 1 (`docs/plans/workers-1.md`) being complete.

## Global Constraints

- Everything in Plan 1's Global Constraints applies.
- Worker home: `${SDLC_HOME:-~/.sdlc}/workers/<id>/`, containing `config.json`, `meta/`, `state.json`, `agent-settings.json`, `worker.pid`, `logs/worker.log`, `logs/runs/<ts>-<effort>-<phase>.log`, `run/result.json`.
- The agent's environment: `SDLC_HEADLESS=1`, `SDLC_WORKER_ID=<id>`, `SDLC_RESULT_FILE=<home>/run/result.json`.
- Result outcomes: `completed | request | failed`. A missing or invalid result file, a non-zero exit or a timeout is `failed`.
- Lease renewal while an agent run is live happens every `lease_ttl / 2`. An idle worker pushes nothing.
- Code-repo branches are pushed with `git push -u origin feat/<slug>` (never forced) before every report and release.
- Every commit a worker makes (meta repo and code repos) is authored as its owner and carries `Worker: <id>`.
- Routing: `ACCEPTED` → `classify-change` then `write-design-doc`; `DESIGNED` → `write-execution-plan`; `PLANNED` / `IN_PROGRESS` → Development (`superpowers:executing-plans`); after Development → `close-out`.

## Review Focus

- **The meta repo remote is unreachable (network down) during a pull.** This is transient. Expect the worker to log it, sleep `idle_poll` and retry, without posting a worker error each time. Pinned in Task 5.
- **The agent edits files outside the effort's docs in the meta clone** (for example `CLAUDE.process.md`). Expect the report to commit only the effort's paths, and the next pull to discard the stray edit (`git checkout -- .` of untracked-by-report paths). Pinned in Task 5.
- **The agent leaves uncommitted changes in a code repo.** Expect the push of `feat/<slug>` to carry only commits, and the report's commit body to name the dirty repo as a warning. Pinned in Task 5.
- **`sdlc worker stop` while the agent is mid-run.** Expect the agent child to be killed, plan progress to be reported, the claim released, and no orphan agent process left. Pinned in Task 7.
- **Two `start` commands for the same worker id.** Expect the second one to refuse ("already running, pid N") instead of running two loops on one home. Pinned in Task 7.

## Repositories

| key | role | tier |
|---|---|---|
| `sdlskills` | owner | standard |

The PR is tracked in `docs/plans/workers-3.md`.

---

### Task 0: Protocol writes never touch the working tree

Added after Plan 1's final review (Ruling 17 in the Plan 1 ledger). Plan 1's `commitFromHead` (scripts/lib/board/git.mjs) lifts uncommitted edits under `docs/feat-req|design|plans` and `board/` out of the working tree into process memory for the whole push. A kill mid-push loses them, and a write made during the push is overwritten. Task 5 renews the lease while an agent is writing exactly those files, so this must be fixed first.

**Files:**
- Modify: `scripts/lib/board/git.mjs` (the `commitFromHead` path of `boardWrite`)
- Modify: the protocol-write callers only if their `mutate` contract changes (`claims.mjs`, `requests.mjs`, `effects.mjs`)
- Test: `scripts/lib/board/git.test.mjs`

**Interfaces:**
- Produces: for protocol kinds (claim, renew, release, request, answer, withdraw, apply), `boardWrite` builds the commit from HEAD blobs in a temporary index (`GIT_INDEX_FILE` in a temp dir: `read-tree HEAD`, `hash-object -w` the patched content, `update-index --cacheinfo`, `write-tree`, `commit-tree`, then update `refs/heads/main`). `mutate` receives a content API (read a path at HEAD, write patched content for a path) and never reads or writes the working tree. After the push lands, each touched path is fast-forwarded in the working tree only if the working file still equals the old HEAD blob. Otherwise the person's copy is left untouched. Report (`onFailure: 'keep-work'`) keeps its current working-tree behaviour.

- [ ] **Step 1: Write the failing tests**

```js
test('process killed mid-push loses no uncommitted docs edit', () => {
  // child process: dirty feat-req body + untracked design draft, renew with hooks.beforePush → process.exit
  // after: both edits still on disk, byte-identical
});
test('a file written during the push survives', () => {
  // hooks.beforePush writes a new line into the dirty plan file; after renew completes it is still there
});
test('protocol commit contains only the patched frontmatter, never working-tree edits', () => {});
test('clean working file is fast-forwarded to the new HEAD; dirty one is left as is', () => {});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test scripts/lib/board/git.test.mjs`
Expected: the new tests fail; the existing ones pass.

- [ ] **Step 3: Replace the working-tree swap with the temporary-index commit**

- [ ] **Step 4: Run the board tests and the full suite**

Run: `node --test "scripts/lib/board/*.test.mjs"` then `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/board/
git commit -m "fix(board): protocol writes commit from a temporary index, never the working tree"
```

### Task 1: Worker home

**Files:**
- Create: `scripts/lib/worker/home.mjs`
- Test: `scripts/lib/worker/home.test.mjs`

**Interfaces:**
- Produces:
  - `sdlcHome(env = process.env) -> string`; `workerHome(id, env) -> string`.
  - `readConfig(home) -> { id, owner, meta_url, agent: 'claude' | 'copilot', model, cli_args: string[], name, author: { name, email }, agent_cmd?: string }`; `writeConfig(home, cfg)`. `agent_cmd` overrides the CLI binary and is used by tests.
  - `readState(home) -> { clean_stop: boolean, failures: number, backoff_until: string | null }` (with defaults when the file is absent); `writeState(home, patch)`.
  - `writePid(home, pid)`, `readPid(home) -> number | null`, `clearPid(home)`, `isAlive(pid) -> boolean` (via `process.kill(pid, 0)`).
  - `agentSettings() -> object`: the Claude Code settings written to `agent-settings.json`, with `sandbox.enabled: true`, `sandbox.autoAllowBashIfSandboxed: true` and `permissions.defaultMode: 'acceptEdits'`.
  - `installTrailerHook(repoDir, workerId)`: writes an executable `.git/hooks/commit-msg` that runs `git interpret-trailers --in-place --if-exists doNothing --trailer "Worker: <id>" "$1"`. It keeps an existing readonly `pre-commit` hook.

- [ ] **Step 1: Write the failing tests**

```js
test('SDLC_HOME overrides ~/.sdlc', () => {});
test('config and state round-trip; state has defaults', () => {});
test('isAlive true for process.pid, false for a reaped child pid', () => {});
test('commit-msg hook adds Worker trailer once, even if commit already has one', () => {});
test('agentSettings enables the sandbox', () => { assert.equal(agentSettings().sandbox.enabled, true); });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test scripts/lib/worker/home.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement the exports**

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test scripts/lib/worker/home.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/worker/home.*
git commit -m "feat(worker): worker home, config, state, pid, trailer hook"
```

### Task 2: Headless agent invocation and the fake agent

**Files:**
- Create: `scripts/lib/worker/agent.mjs`
- Create: `scripts/lib/worker/fixtures/fake-agent.mjs`
- Test: `scripts/lib/worker/agent.test.mjs`

**Interfaces:**
- Consumes: `readConfig`, `agentSettings` (Task 1), `safeExcerpt` (Plan 1, Task 7).
- Produces:
  - `route(status: string) -> { phase: string, skills: string[] } | null`, the routing table from Global Constraints. `IMPLEMENTED`, `PARKED` and `REJECTED` give `null`.
  - `buildPrompt({ workerId, slug, status, agent, agentInput: string[] }) -> string`. It contains the worker id, the slug, each skill name (`claude`) or `.github/skills/<skill>/SKILL.md` path (`copilot`), "Follow \"Headless mode\" in the process contract", "Do not commit or push in the meta repo", and each `agentInput` entry under "Answered requests to apply first:".
  - `agentCommand(cfg, prompt, home) -> { cmd, args, env }`:
    - `claude`: `['-p', prompt, '--model', m, '--output-format', 'json', '--settings', <home>/agent-settings.json, ...cli_args]`;
    - `copilot`: `['-p', prompt, '--model', m, '--allow-all-tools', '--no-color', ...cli_args]`;
    - `cmd = cfg.agent_cmd ?? cfg.agent`;
    - `env` adds the three `SDLC_*` variables.
  - `runAgent({ cmd, args, env, cwd, timeoutMs, logPath, onTick?: () => Promise<void>, tickMs? }) -> Promise<{ exitCode, timedOut, stderrTail: string }>`. It tees output to `logPath`, kills the process group on timeout, and calls `onTick` every `tickMs` while the agent runs (Task 5 uses it for lease renewal).
  - `readResult(path) -> { ok: true, result } | { ok: false, problem: string }`. It validates `outcome`, and also `request.kind` and `sections` when `outcome` is `request`.
  - `classifyFailure({ exitCode, timedOut, stderrTail, spawnError }) -> 'worker' | 'effort'`. `ENOENT` on spawn, or stderr matching `/model/i` together with `/not (found|available|supported)|invalid|unknown/i`, gives `worker`. Everything else gives `effort`.
- Produces (`fixtures/fake-agent.mjs`): it reads `FAKE_AGENT_SCRIPT` (a path to JSON `{ writes: {relPath: content}, result: object | null, exitCode, sleepMs, stderr }`), performs the writes relative to cwd, sleeps, writes `result` to `$SDLC_RESULT_FILE` unless it's null, prints `stderr`, and exits with `exitCode`.

- [ ] **Step 1: Write the failing tests**

```js
test('route maps each status to its skills', () => {});
test('buildPrompt for copilot names SKILL.md paths; includes answered input', () => {});
test('agentCommand claude passes --settings and --model; env has SDLC_HEADLESS=1', () => {});
test('runAgent with the fake agent: exit code, log written, onTick called', () => {});
test('runAgent kills on timeout and reports timedOut', () => {});
test('readResult rejects a missing file, bad JSON and an unknown outcome', () => {});
test('classifyFailure: ENOENT and model errors are worker errors', () => {});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test scripts/lib/worker/agent.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement `agent.mjs` and the fake agent**

Spawn with `detached: true`, so the timeout and `stop` can kill the whole group with `process.kill(-pid)`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test scripts/lib/worker/agent.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/worker/agent.* scripts/lib/worker/fixtures/
git commit -m "feat(worker): headless agent invocation, result file, fake agent"
```

### Task 3: Preflight

**Files:**
- Create: `scripts/lib/worker/preflight.mjs`
- Test: `scripts/lib/worker/preflight.test.mjs`

**Interfaces:**
- Consumes: `readWorker` (Plan 1, Task 10), `readConfig` (Task 1).
- Produces: `preflight({ home, cfg, root, gh: { authOk: () => boolean }, which: (cmd) => boolean }) -> { ok: true } | { ok: false, problem: string, kind: 'worker' | 'fatal' }`. A failed `gh` login or an agent CLI missing from `PATH` gives `worker` (post a worker error and idle). No registry entry, a retired entry, or `agent`/`model` differing from the registry gives `fatal` (exit with the message; no request is posted, because a retired or unregistered worker must not write to the board).

- [ ] **Step 1: Write the failing tests**: one per outcome: ok; gh logged out; CLI missing; unregistered; retired; model mismatch.
- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test scripts/lib/worker/preflight.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement `preflight`**
- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test scripts/lib/worker/preflight.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/worker/preflight.*
git commit -m "feat(worker): preflight checks before every claim"
```

### Task 4: `assemble-env` trailer hooks

**Files:**
- Modify: `scripts/assemble-env.mjs` (the `assemble()` signature and loop, around `:89-133`)
- Test: `scripts/assemble-env.test.mjs`

**Interfaces:**
- Consumes: `installTrailerHook` (Task 1).
- Produces: `assemble({ rootDir, slug, keys, catalog, hooks?: { workerId: string } })`. When `hooks` is given, `installTrailerHook(dest, workerId)` runs on every non-readonly checkout. Without it, behaviour is unchanged.

- [ ] **Step 1: Write the failing test**

```js
test('hooks.workerId installs the commit-msg trailer hook on writable checkouts only', () => {});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test scripts/assemble-env.test.mjs`
Expected: the new test fails, and the existing tests pass.

- [ ] **Step 3: Add the `hooks` option**
- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test scripts/assemble-env.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/assemble-env.*
git commit -m "feat(assemble-env): optional Worker trailer hook on effort checkouts"
```

### Task 5: The loop step: claim, run, report

**Files:**
- Create: `scripts/lib/worker/loop.mjs`
- Test: `scripts/lib/worker/loop.test.mjs`

**Interfaces:**
- Consumes: Plan 1 (`claim`, `renew`, `release`, `holds`, `rank`, `overlaps`, `loadEfforts`, `postRequest`, `listRequests`, `applyAnswered`, `answeredFor`, `boardWrite`, `loadConfig`, `sync`, `safeExcerpt`, `buildRequest`, `newRequestId`); Tasks 1–4.
- Produces:
  - `makeContext({ home, deps }) -> ctx`. `deps = { now, sleep, gh, which, runAgent, assemble, log }` defaults to the real ones.
  - `step(ctx) -> Promise<{ action: 'idle' | 'needs-attention' | 'claimed' | 'lost' | 'reported' | 'requested' | 'failed' | 'done', effort?: string }>`: one iteration of the design's loop:
    1. preflight;
    2. if the worker holds an effort (`ctx.holding`), check `holds()` again; otherwise `sync` → `rank` → overlap warning → `claim`;
    3. `applyAnswered`;
    4. `assemble` with `hooks`;
    5. `runAgent`, with `onTick` = `renew` every `leaseTtlMs / 2`;
    6. handle the result;
    7. push the code branches before any report or release.
  - `reportPaths(root, slug) -> string[]`: the same path set as `sdlc report` (Plan 1, Task 11), extracted there into `scripts/lib/board/paths.mjs` and imported here.
  - Result handling:
    - `completed` → a `report` commit with `Phase:` and `renewed_at`;
    - `request` → `postRequest`, with `releaseFrom` when blocking;
    - `failed` → an effort error (redacted last 50 log lines), release, `failures++`, `backoff_until = now + backoffMs[min(failures-1, len-1)]`;
    - a worker-classified failure → a worker error request (one open per worker), with `action: 'needs-attention'`.
  - The `failures` count resets on `completed`. Status `IMPLEMENTED` after a report → release, `action: 'done'`.

- [ ] **Step 1: Write the failing tests** (`makeBoard` plus the fake agent, `deps.sleep` as a no-op, a fixed `deps.now`):

```js
test('ACCEPTED effort: claim → run → report with Phase trailer and renewed lease', () => {});
test('every commit (meta and code repo) has Worker trailer and owner author', () => {});
test('blocking request: one commit posts it, sets awaiting, releases; next step picks other work', () => {});
test('clarification: posted, claim kept, run continues next step', () => {});
test('agent exit 1 / no result file / timeout → effort error with redacted excerpt, release, backoff set', () => {});
test('backoff: no claim while now < backoff_until', () => {});
test('model-not-found stderr → worker error, needs-attention, no claim until answered resolved', () => {});
test('taken over between steps → action lost, nothing pushed for that effort', () => {});
test('person parks the effort mid-hold → lost, nothing pushed', () => {});
test('code branch feat/<slug> pushed before report; dirty code repo named in report body', () => {});
test('stray edit to CLAUDE.process.md is not committed and is discarded on next sync', () => {});
test('remote unreachable → idle with a log line, no worker error posted', () => {});
test('empty queue → idle, zero commits pushed', () => {});
test('answered clarification on held effort → rework step added before next run', () => {});
test('lease renewed during a run longer than ttl/2; no renew when the run is short', () => {});
test('two workers with separate homes on one machine, steps interleaved: different efforts, no shared files', () => {});
test('takeover of a stale IN_PROGRESS effort: workspace built from origin/feat/<slug>, prompt says resume from first unchecked step', () => {});
test('overlap with another live claim: warning logged and named in the claim commit body, claim proceeds', () => {});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test scripts/lib/worker/loop.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Extract `reportPaths` into `scripts/lib/board/paths.mjs`, and make `cli.mjs` use it**

Run: `node --test scripts/lib/board/cli.test.mjs`
Expected: PASS (unchanged behaviour).

- [ ] **Step 4: Implement `makeContext` and `step`**

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `node --test scripts/lib/worker/loop.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/worker/loop.* scripts/lib/board/paths.mjs scripts/lib/board/cli.mjs
git commit -m "feat(worker): loop step: claim, apply answers, run agent, report"
```

### Task 6: `sdlc worker create`

**Files:**
- Create: `scripts/lib/worker/create.mjs`
- Test: `scripts/lib/worker/create.test.mjs`

**Interfaces:**
- Consumes: Task 1, Task 2 (`agentCommand`, `runAgent` for the probe), Plan 1 (`boardWrite`, `workerYaml`, `DEFAULT_CONFIG_YAML`).
- Produces:
  - `newWorkerId(login, rand = Math.random) -> string` (`<login>-<6 base36>`).
  - `resolveOwner(gh) -> { login, name, email }`. It uses `gh api user`, and the email falls back to `<id>+<login>@users.noreply.github.com`.
  - `createWorker({ metaUrl, agent, model, name?, probe = true, gh, env, now, host = os.hostname() }) -> { id, home }`, in order:
    1. resolve the owner;
    2. probe (`agentCommand` with prompt `Reply with OK.`; a non-zero exit throws `CreateError('agent/model probe failed: …')`);
    3. clone `meta/`;
    4. check the kit flavor (`.claude/skills/select-next-task/SKILL.md` or `.github/skills/select-next-task/SKILL.md`, otherwise throw);
    5. set the author and install the trailer hook;
    6. write `config.json` and `agent-settings.json`;
    7. register with `boardWrite` (`kind: 'register'`, `onReject: 'restart'`), creating `board/workers/.gitkeep`, `board/requests/.gitkeep` and `board/config.yml` when `board/` is missing.
    If the id file already exists, it uses a new id (up to 5 tries). On a lost race it re-syncs and retries. Any throw deletes the home before rethrowing.

- [ ] **Step 1: Write the failing tests** (a stub `gh` and the fake agent as `agent_cmd`):

```js
test('creates home, registers on main under the owner, id shape', () => {
  assert.match(id, /^lidorl-[a-z0-9]{6}$/);
  // board/workers/<id>.yml on remote has owner lidorl, agent, model, host, created_at
});
test('creates board/ and seeds config.yml when missing', () => {});
test('id collision → new suffix', () => {});
test('push rejected → retries with a fresh pull', () => {});
test('probe failure / wrong kit flavor / push failure → no home left behind', () => {});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test scripts/lib/worker/create.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement `create.mjs`**
- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test scripts/lib/worker/create.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/worker/create.*
git commit -m "feat(worker): sdlc worker create with registration and rollback"
```

### Task 7: Worker lifecycle commands

**Files:**
- Create: `scripts/lib/worker/cli.mjs`
- Test: `scripts/lib/worker/cli.test.mjs`
- Modify: `scripts/lib/board/cli.mjs` (dispatch `worker` to `scripts/lib/worker/cli.mjs`, and remove the Plan 1 placeholder and its test)

**Interfaces:**
- Consumes: Tasks 1–6, Plan 1 (`boardWrite`, `release`, `workerState`), `isProtected` (exported from `scripts/clean-env.mjs` in this task).
- Produces: `runWorker(argv, deps) -> Promise<number>`, with these subcommands:
  - `create --agent <a> --model <m> [--name n] [--meta <url>] [--no-probe]`. `--meta` defaults to the cwd clone's `origin`.
  - `start <id> [--detach]`:
    - It refuses when `readPid` gives a live pid ("already running, pid N").
    - Crash detection: a stale pid file, or `clean_stop` false with a previous start, pushes a `crash` event and posts a worker error.
    - It pushes `start`, writes the pid file, sets `clean_stop: false` and loops `step()`, sleeping `idlePollMs` on `idle`.
    - SIGTERM/SIGINT handling: kill the agent group, run the final report and release, push `stop`, set `clean_stop: true`, clear the pid file and exit 0.
    - `--detach` spawns `node <home>/meta/scripts/sdlc.mjs worker start <id>` with `detached: true`, stdio to `logs/worker.log`, and `unref()`, then prints the pid and returns.
  - `once <id>`: start, one claim-to-report cycle, release, stop. With an empty queue it exits 0 and prints `queue empty`.
  - `stop <id>`: SIGTERM, wait up to 60 s, then SIGKILL; after a kill, it does the release and the `stop` event itself from `<home>/meta`.
  - `status <id>`, `list`: the local homes joined with `workerState`.
  - `retire <id> [--force]`: stop, release, `retired_at` (`retire` event), then delete the home. It refuses if `isProtected` holds for any `meta/workspace/*` checkout, unless `--force`.
  - `config <id> --model <m>`: updates `config.json` and the registry in one `config` event.

- [ ] **Step 1: Write the failing tests**

```js
test('start refuses when already running', () => {});
test('stop then start: same id and home, registry file unchanged', () => {});
test('SIGTERM mid-run: agent group killed, plan progress reported, claim released, stop event, clean_stop true', () => {});
test('stale pid file on start → crash event + worker error request', () => {});
test('start --detach returns immediately; process survives the parent; stop ends it and pushes stop', () => {});
test('once with empty queue exits 0 and prints "queue empty"', () => {});
test('config --model updates config.json and registry; start refuses on mismatch', () => {});
test('retire keeps the registry entry with retired_at, deletes home, refuses on unpushed work without --force', () => {});
test('a retired worker cannot claim or report (fatal preflight)', () => {});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test scripts/lib/worker/cli.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Export `isProtected` from `scripts/clean-env.mjs`**

Run: `node --test scripts/clean-env.test.mjs`
Expected: PASS (behaviour unchanged).

- [ ] **Step 4: Implement `runWorker` and wire the dispatch in `board/cli.mjs`**

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `node --test scripts/lib/worker/cli.test.mjs scripts/lib/board/cli.test.mjs`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/worker/cli.* scripts/lib/board/cli.* scripts/clean-env.mjs
git commit -m "feat(worker): start/once/stop/status/list/retire/config lifecycle"
```
