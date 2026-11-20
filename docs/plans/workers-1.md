---
feat_req: docs/feat-req/workers.md
design: docs/design/workers.md
status: IMPLEMENTED
date: 2026-11-20
plan: 1 of 3
repos: [sdlskills]
---

# Workers and the work board: Plan 1, the board library

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the board protocol (claims, leases, requests, answers, effects, events, registry) as tested library code, plus the `sdlc` commands a person uses against a board, with nothing in the lifecycle depending on it yet.

**Architecture:** Every board write goes through one primitive, `boardWrite` (pull, mutate, commit only the touched paths, push, validate), so the claim protocol lives in one place. Board data is files on `main` (feat-req frontmatter, `board/workers/*.yml`, `board/requests/*.md`, `board/config.yml`). Board commits carry a fixed subject plus trailers, and `git log` is parsed back into events. `scripts/sdlc.mjs` is a thin dispatcher over the library.

**Tech Stack:** Node ≥20 (`node:test`, `node:fs`, `node:child_process`), the `yaml` dependency, the `git` CLI.

**Spec:** `docs/design/workers.md` (sections: The board primitive, Data on the board, Answers and effects, Interactive sessions, `sdlc` command summary, Settings). Also `docs/feat-req/workers.md` (binding contracts) and ADR 005.

## Global Constraints

- Node ≥20. Built-ins, `git`/`gh` shell-outs and the one dependency `yaml`. No other npm packages (ADR 004).
- New code lives in `scripts/lib/board/` and `scripts/sdlc.mjs`, with tests alongside as `*.test.mjs`. `npm test` runs them.
- Nothing ever force-pushes. No `--force`, `-f` or `+refspec` anywhere in `scripts/lib/board/`, `scripts/lib/worker/` or `scripts/sdlc.mjs`.
- A rebase conflict is never resolved in the writer's favour: abort, reset to `origin/main` and report it.
- Board mode is on only when `board/` exists at the root. With no `board/`, nothing in this plan changes any existing behaviour.
- Worker id: `<login>-<6 lowercase base36 chars>`. Request id: `YYYYMMDDHHMM-<6 lowercase base36 chars>`, matching `^\d{12}-[a-z0-9]{6}$`.
- Commit subject: `board(<kind>): <subject>`. Trailers: `Worker`, `Sdlc-Event`, `Effort`, `Request`, `Phase`, `Replaces`, `Answered-by`.
- Event kinds: `register config start stop crash claim renew release takeover report request answer apply withdraw retire`.
- Defaults: `lease_ttl: 4h`, `idle_poll: 60s`, `phase_timeout: 3h`, `backoff: [5m, 15m, 60m]`, `watch_interval: 30s`.
- Error excerpts are at most 50 lines and always redacted before any file write.

## Review Focus

- **Running `sdlc` in a person's clone that isn't on `main`, or has unrelated uncommitted edits.** Expect a refusal off `main`, and unrelated dirty files left exactly as they were. Pinned in Task 4.
- **A hand-edited board file with broken YAML** (feat-req frontmatter, request or config). Expect `sdlc check` to name the file and the problem, and the queue and inbox to skip that file instead of crashing. Pinned in Tasks 6 and 8.
- **Clock skew between machines.** A `renewed_at` in the future (another machine's clock is ahead) must read as live, never as stale or as a negative age. Pinned in Task 5.
- **A feat-req deleted, renamed or set to `PARKED` by a person while a claim is held.** Expect `holds()` to return false, so the holder stops. Pinned in Task 5.
- **An answer for a request that was withdrawn or already applied (file gone).** Expect `sdlc answer` to exit non-zero with "no such open request" and push nothing. Pinned in Task 11.

## Repositories

| key | role | tier |
|---|---|---|
| `sdlskills` | owner | standard |

Single-repo effort. `repos.yml` and `workspace/` don't apply to building the kit itself. The PR is tracked in `docs/plans/workers-3.md`.

---

### Task 1: Frontmatter read and edit

**Files:**
- Create: `scripts/lib/board/frontmatter.mjs`
- Test: `scripts/lib/board/frontmatter.test.mjs`

**Interfaces:**
- Produces:
  - `parseDoc(text: string) -> { data: object, body: string }`. Throws `FrontmatterError` (exported) on invalid YAML.
  - `setFields(text: string, patch: object) -> string`. A `null` value deletes the key. Other keys keep their order, and the body is unchanged byte-for-byte.
  - `appendToSection(text: string, heading: string, line: string) -> string`. Appends `line` under `## <heading>`, creating the section at the end of the file if it's absent.

- [x] **Step 1: Write the failing tests**

```js
test('setFields adds, changes and deletes keys, keeps body and key order', () => {
  const src = '---\ndate: 2026-11-19\nstatus: ACCEPTED\npriority: High\n---\n\n# T\n\nbody `x`\n';
  const out = setFields(src, { status: 'DESIGNED', claimed_by: 'lidorl-7f3a9c', priority: null });
  assert.equal(out, '---\ndate: 2026-11-19\nstatus: DESIGNED\nclaimed_by: lidorl-7f3a9c\n---\n\n# T\n\nbody `x`\n');
});
test('parseDoc reads flat frontmatter', () => {
  assert.deepEqual(parseDoc('---\na: 1\nb: x\n---\nB').data, { a: 1, b: 'x' });
});
test('parseDoc throws FrontmatterError on broken YAML', () => {
  assert.throws(() => parseDoc('---\na: [1,\n---\n'), FrontmatterError);
});
test('appendToSection creates ## Decisions at the end, then appends to it', () => {
  let t = '---\na: 1\n---\n# T\n\n## Triage\nx\n';
  t = appendToSection(t, 'Decisions', '- one');
  t = appendToSection(t, 'Decisions', '- two');
  assert.match(t, /## Triage\nx\n\n## Decisions\n- one\n- two\n$/);
});
test('appendToSection inserts before the next ## heading when the section is in the middle', () => {
  const t = appendToSection('# T\n\n## Decisions\n- one\n\n## Other\ny\n', 'Decisions', '- two');
  assert.match(t, /## Decisions\n- one\n- two\n\n## Other/);
});
```

- [x] **Step 2: Run the tests and confirm they fail**

Run: `node --test scripts/lib/board/frontmatter.test.mjs`
Expected: FAIL, "Cannot find module".

- [x] **Step 3: Implement `parseDoc`, `setFields` and `appendToSection`**

Use the `yaml` package's `parseDocument` so existing key order is kept, and serialize only the frontmatter block. Ignore headings inside ``` fences when finding sections (same approach as `render-status.mjs` `parsePullRequests`).

- [x] **Step 4: Run the tests and confirm they pass**

Run: `node --test scripts/lib/board/frontmatter.test.mjs`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add scripts/lib/board/frontmatter.mjs scripts/lib/board/frontmatter.test.mjs
git commit -m "feat(board): frontmatter read and edit"
```

### Task 2: Board settings

**Files:**
- Create: `scripts/lib/board/config.mjs`
- Test: `scripts/lib/board/config.test.mjs`

**Interfaces:**
- Produces:
  - `DEFAULT_CONFIG_YAML: string`, the exact commented file from the design's "Settings" section.
  - `parseDuration(s: string) -> number` (ms). Accepts `<int>(s|m|h|d)`, and throws on anything else.
  - `loadConfig(root: string) -> { leaseTtlMs, idlePollMs, phaseTimeoutMs, backoffMs: number[], watchIntervalMs }`. It reads `board/config.yml`; a missing file or a missing key falls back to the defaults.
  - `validateConfig(obj) -> string[]`, a list of problems.
  - `boardEnabled(root: string) -> boolean`: whether `board/` is a directory.

- [x] **Step 1: Write the failing tests**

```js
test('parseDuration', () => {
  assert.equal(parseDuration('4h'), 4 * 3600e3);
  assert.equal(parseDuration('30s'), 30e3);
  assert.throws(() => parseDuration('4 hours'));
});
test('loadConfig falls back per key', () => {
  // board/config.yml contains only "lease_ttl: 1h"
  const c = loadConfig(root);
  assert.equal(c.leaseTtlMs, 3600e3);
  assert.equal(c.idlePollMs, 60e3);
  assert.deepEqual(c.backoffMs, [300e3, 900e3, 3600e3]);
});
test('DEFAULT_CONFIG_YAML parses to the defaults', () => { /* write it, loadConfig, compare to no-file result */ });
test('validateConfig flags unknown keys and bad durations', () => {
  assert.deepEqual(validateConfig({ lease_ttl: 'soon', colour: 1 }).length, 2);
});
test('boardEnabled is false without board/ and true with it', () => { /* … */ });
```

- [x] **Step 2: Run the tests and confirm they fail**

Run: `node --test scripts/lib/board/config.test.mjs`
Expected: FAIL.

- [x] **Step 3: Implement the five exports in `config.mjs`**

- [x] **Step 4: Run the tests and confirm they pass**

Run: `node --test scripts/lib/board/config.test.mjs`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add scripts/lib/board/config.*
git commit -m "feat(board): board/config.yml settings with defaults"
```

### Task 3: Event format and log parsing

**Files:**
- Create: `scripts/lib/board/events.mjs`
- Test: `scripts/lib/board/events.test.mjs`

**Interfaces:**
- Produces:
  - `EVENT_KINDS: string[]` (Global Constraints list).
  - `formatMessage({ kind, subject, trailers: { worker?, effort?, request?, phase?, replaces?, answeredBy? } }) -> string`. The subject line is `board(<kind>): <subject>`, then a blank line, then the trailers in the fixed order `Worker, Sdlc-Event, Effort, Request, Phase, Replaces, Answered-by`. `Sdlc-Event` is always present.
  - `parseLog(root: string, { ref = 'origin/main', limit = 2000, sinceSha? }) -> Event[]`, newest first. `Event = { sha, author, at: Date, kind, subject, worker, effort, request, phase, replaces, answeredBy }`. Commits without `Sdlc-Event` are skipped. With `sinceSha`, only the commits after it are returned.

- [x] **Step 1: Write the failing tests**

```js
test('formatMessage', () => {
  assert.equal(
    formatMessage({ kind: 'claim', subject: 'bulk-export', trailers: { worker: 'lidorl-7f3a9c', effort: 'bulk-export' } }),
    'board(claim): bulk-export\n\nWorker: lidorl-7f3a9c\nSdlc-Event: claim\nEffort: bulk-export\n');
});
test('parseLog round-trips formatMessage, skips non-board commits, honours sinceSha', () => {
  // repo with: a plain commit, an empty claim commit, a report commit with Phase
  const ev = parseLog(repo, { ref: 'HEAD' });
  assert.deepEqual(ev.map((e) => e.kind), ['report', 'claim']);
  assert.equal(ev[0].phase, 'DESIGNED');
  assert.equal(parseLog(repo, { ref: 'HEAD', sinceSha: ev[1].sha }).length, 1);
});
```

- [x] **Step 2: Run the tests and confirm they fail**

Run: `node --test scripts/lib/board/events.test.mjs`
Expected: FAIL.

- [x] **Step 3: Implement `formatMessage` and `parseLog`**

`parseLog` runs `git log <ref> -n <limit> --format=%H%x00%an%x00%aI%x00%s%x00%(trailers:unfold,only)%x1e` and splits on `\x1e`. With `sinceSha`, it uses the range `<sinceSha>..<ref>`.

- [x] **Step 4: Run the tests and confirm they pass**

Run: `node --test scripts/lib/board/events.test.mjs`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add scripts/lib/board/events.*
git commit -m "feat(board): commit trailer event format and log parser"
```

### Task 4: The board write primitive and the test fixture

**Files:**
- Create: `scripts/lib/board/git.mjs`
- Create: `scripts/lib/board/fixtures.mjs` (test helper, exported functions only)
- Test: `scripts/lib/board/git.test.mjs`
- Test: `scripts/lib/board/no-force.test.mjs`

**Interfaces:**
- Consumes: `formatMessage` (Task 3).
- Produces (`git.mjs`):
  - `sync(clone: string) -> void`: `fetch origin main`, then a fast-forward to `origin/main` (with `--autostash` when the tree is dirty).
  - `assertOnMain(clone: string) -> void`: throws `BoardError('not on main')` when `HEAD` isn't `main`.
  - `boardWrite(clone, { kind, subject, trailers, identity: { name, email }, mutate: (clone) => string[], validate?: (clone) => boolean, onReject: 'restart' | 'rebase', hooks?: { beforePush?: () => void } }) -> { ok: true, sha } | { ok: false, reason: 'lost-race' | 'conflict' | 'replaced' | 'nothing-to-do' }`.
    - When `mutate` returns `[]` and `kind` is in `{start, stop, crash, renew}`, it makes an empty commit. When `mutate` returns `[]` for any other kind, it returns `nothing-to-do`.
    - It commits with `git commit --only -- <paths>`, with the author set from `identity`.
    - `rebase` retries up to 5 times, with a 50–250 ms jitter.
  - `BoardError extends Error`.
- Produces (`fixtures.mjs`):
  - `makeBoard({ featReqs?: Record<slug, frontmatterObj>, board?: boolean = true }) -> { dir, remote, clone(name) -> path, seed(path, content, msg) }`. A bare remote seeded with `docs/feat-req/<slug>.md`, `board/workers/.gitkeep` and `board/requests/.gitkeep`. Each `clone()` is a fresh clone with `user.name`/`user.email` set.
  - `IDENT = { name: 'Test Owner', email: 'owner@example.com' }`.

- [x] **Step 1: Write the failing tests**

```js
test('writes, pushes and returns the sha that is on origin/main', () => { /* mutate writes one file */ });
test('restart: a rejected push resets to origin/main and returns lost-race', () => {
  // clone B pushes first (via hooks.beforePush on A)
  assert.deepEqual(r, { ok: false, reason: 'lost-race' });
  assert.equal(revParse(a, 'HEAD'), revParse(a, 'origin/main'));
});
test('rebase: a rejected push on unrelated files rebases and succeeds', () => {});
test('rebase: a conflicting change aborts, resets and returns conflict', () => {});
test('validate false after push returns replaced', () => {});
test('empty event commit for start', () => { /* git show --stat shows no files; trailer Sdlc-Event: start */ });
test('--only leaves unrelated dirty files untouched and uncommitted', () => {
  // dirty notes.md before the write; afterwards git status still shows " M notes.md" and HEAD doesn't contain it
});
test('assertOnMain throws off main', () => {});
```

`no-force.test.mjs` walks `scripts/lib/board/`, `scripts/lib/worker/` (if present) and `scripts/sdlc.mjs` (if present). It asserts no source file (excluding `*.test.mjs`) matches `/--force|['"]-f['"]|\+refs\/|\+HEAD/`.

- [x] **Step 2: Run the tests and confirm they fail**

Run: `node --test scripts/lib/board/git.test.mjs scripts/lib/board/no-force.test.mjs`
Expected: `git.test.mjs` fails (module missing). `no-force` passes trivially.

- [x] **Step 3: Implement `fixtures.mjs`, then `git.mjs`**

The post-push validation does `sync`, then `git merge-base --is-ancestor <sha> origin/main`, then `validate(clone)`.

- [x] **Step 4: Run the tests and confirm they pass**

Run: `node --test scripts/lib/board/git.test.mjs scripts/lib/board/no-force.test.mjs`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add scripts/lib/board/git.* scripts/lib/board/fixtures.mjs scripts/lib/board/no-force.test.mjs
git commit -m "feat(board): pull/commit/push/validate primitive, never forced"
```

### Task 5: Claims, leases, release and takeover

**Files:**
- Create: `scripts/lib/board/claims.mjs`
- Test: `scripts/lib/board/claims.test.mjs`

**Interfaces:**
- Consumes: `boardWrite`, `sync` (Task 4), `parseDoc`, `setFields`, `appendToSection` (Task 1).
- Produces:
  - `claimState(fm: object, now: Date, ttlMs: number) -> 'unclaimed' | 'live' | 'stale'`. Age is `now − (renewed_at ?? claimed_at)`, and an age below zero (a clock ahead of ours) is `live`.
  - `claim(clone, slug, { claimant, identity, workerId?, now, ttlMs, isAwaitingOpen: (fm) => boolean, hooks? }) -> { ok: true, takeover: string | null } | { ok: false, reason: 'held' | 'awaiting' | 'gone' | 'lost-race' | 'conflict' | 'replaced' }`.
    - It sets `claimed_by`, `claimed_at` and `renewed_at`, with `onReject: 'restart'`, and its `validate` checks `claimed_by === claimant`.
    - A stale claim becomes a takeover: the `Replaces:` trailer, plus `appendToSection('Decisions', '- <date> · takeover · <claimant> took over from <old> (claim stale since <renewed_at>)')`.
  - `renew(clone, slug, { claimant, identity, workerId?, now }) -> result`. It sets only `renewed_at`, as an event kind `renew` commit, and fails `replaced` if the claim isn't held.
  - `release(clone, slug, { claimant, identity, workerId?, extraMutate?: (clone) => string[] }) -> result`. It clears the three claim fields, and `extraMutate` lets a request post ride in the same commit.
  - `holds(clone, slug, claimant) -> boolean`: whether the file exists, `claimed_by === claimant`, and `status` isn't `PARKED`, `REJECTED` or `IMPLEMENTED`.

- [x] **Step 1: Write the failing tests**

```js
test('race: two clones claim the same effort, exactly one holds it on origin/main', () => {
  // A.claim with hooks.beforePush = () => B.claim(...) completes first
  assert.equal(rA.ok, false); assert.equal(rA.reason, 'lost-race');
  assert.equal(rB.ok, true);
  assert.equal(fmOnRemote('bulk-export').claimed_by, 'b-worker1');
});
test('rebase conflict on claim fields is never resolved in our favour', () => {});
test('claim replaced between push and validate → replaced, holds() false', () => {});
test('live claim by someone else → held; awaiting open → awaiting', () => {});
test('stale claim → takeover with Replaces trailer and a ## Decisions line', () => {});
test('claimState: future renewed_at (clock skew) is live', () => {
  assert.equal(claimState({ claimed_by: 'x', renewed_at: '2026-11-20T12:00:00Z' }, new Date('2026-11-20T11:00:00Z'), 4 * 3600e3), 'live');
});
test('holds() is false once a person parks or deletes the feat-req', () => {});
test('release clears claimed_by/claimed_at/renewed_at and leaves other fields', () => {});
test('renew touches only renewed_at', () => {});
```

- [x] **Step 2: Run the tests and confirm they fail**

Run: `node --test scripts/lib/board/claims.test.mjs`
Expected: FAIL.

- [x] **Step 3: Implement the five exports**

The feat-req path is `docs/feat-req/<slug>.md`. A missing file returns `gone`.

- [x] **Step 4: Run the tests and confirm they pass**

Run: `node --test scripts/lib/board/claims.test.mjs`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add scripts/lib/board/claims.*
git commit -m "feat(board): claims, leases, release and takeover"
```

### Task 6: Queue ranking and overlap

**Files:**
- Create: `scripts/lib/board/queue.mjs`
- Test: `scripts/lib/board/queue.test.mjs`

**Interfaces:**
- Consumes: `parseDoc` (Task 1), `claimState` (Task 5), `loadCatalog` (`scripts/lib/catalog.mjs`, existing).
- Produces:
  - `loadEfforts(root) -> { efforts: Effort[], problems: { file, message }[] }`. `Effort = { slug, status, priority, severity, date, fm, repos: string[], security: boolean }`. `repos` comes from `docs/design/<slug>.md` `repos:`. Unparseable files go to `problems` and are skipped.
  - `rank(efforts, { now, ttlMs, openRequestIds: Set<string> }) -> Effort[]`. Candidates are status in `{ACCEPTED, DESIGNED, PLANNED, IN_PROGRESS}`, not live-claimed, and not `awaiting` an id in `openRequestIds`. The order follows `select-next-task` Step 3, rules 2–5: Critical or security first; then in-flight (past `ACCEPTED`) before new; then priority `High > Medium > Low`; then oldest `date`, with a missing date as oldest. Unclaimed and stale efforts both count as candidates.
  - `overlaps(effort, efforts, { now, ttlMs, readonlyKeys: Set<string> }) -> { slug, repos: string[] }[]`: the other live-claimed efforts sharing non-readonly repos.

- [x] **Step 1: Write the failing tests**

```js
test('rank applies severity, in-flight, priority, age in that order', () => {});
test('rank skips live claims and awaiting-open efforts, keeps stale and answered-awaiting', () => {});
test('rank excludes PARKED, REJECTED, IMPLEMENTED', () => {});
test('a feat-req with broken frontmatter is reported in problems and skipped', () => {});
test('overlaps names the other effort and only shared writable repos', () => {
  assert.deepEqual(overlaps(a, all, opts), [{ slug: 'b', repos: ['api'] }]); // 'docs' is readonly, ignored
});
```

- [x] **Step 2: Run the tests and confirm they fail**

Run: `node --test scripts/lib/board/queue.test.mjs`
Expected: FAIL.

- [x] **Step 3: Implement `loadEfforts`, `rank` and `overlaps`**

`security` is true when the frontmatter has `security: true` or a `tags` array that includes `security`.

- [x] **Step 4: Run the tests and confirm they pass**

Run: `node --test scripts/lib/board/queue.test.mjs`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add scripts/lib/board/queue.*
git commit -m "feat(board): queue ranking and repo-overlap detection"
```

### Task 7: Secret redaction

**Files:**
- Create: `scripts/lib/board/redact.mjs`
- Test: `scripts/lib/board/redact.test.mjs`

**Interfaces:**
- Produces:
  - `redact(text: string, env = process.env) -> string`. It replaces each match with `[REDACTED]`.
  - `safeExcerpt(text: string, { maxLines = 50, env = process.env }) -> { text: string, withheld: boolean }`. It takes the last `maxLines` lines and redacts them. If `redact` throws, it returns `{ text: 'excerpt withheld: redaction failed', withheld: true }`.

- [x] **Step 1: Write the failing tests**

One planted token per pattern. Each assertion checks the token is absent and `[REDACTED]` is present:
`ghp_` + 36 chars, `github_pat_` + 82 chars, `gho_`/`ghu_`/`ghs_`/`ghr_`, `sk-ant-api03-…`, `sk-…` (48 chars), `AKIA` + 16 uppercase chars, `xoxb-…`/`xoxp-…`, a three-part JWT `eyJ….eyJ….…`, a `-----BEGIN … PRIVATE KEY-----` … `-----END … PRIVATE KEY-----` block, `Authorization: Bearer <tok>`, `https://user:pass@host`, `password=hunter2` / `api_key: abc` / `secret="x"`, and the value of an env var `MY_SERVICE_TOKEN=s3cr3tvalue` appearing bare in the text.
Plus:

```js
test('safeExcerpt keeps the last 50 lines', () => {});
test('safeExcerpt withholds the excerpt when redaction throws', () => {
  // env whose getter throws
});
test('plain text is unchanged', () => {});
```

- [x] **Step 2: Run the tests and confirm they fail**

Run: `node --test scripts/lib/board/redact.test.mjs`
Expected: FAIL.

- [x] **Step 3: Implement `redact` and `safeExcerpt`**

Env values are redacted only when the name matches `/TOKEN|SECRET|KEY|PASSWORD/i` and the value is at least 6 characters long, so short values don't erase ordinary words.

- [x] **Step 4: Run the tests and confirm they pass**

Run: `node --test scripts/lib/board/redact.test.mjs`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add scripts/lib/board/redact.*
git commit -m "feat(board): secret redaction for error excerpts"
```

### Task 8: Requests: format, validate, post, answer, withdraw

**Files:**
- Create: `scripts/lib/board/requests.mjs`
- Test: `scripts/lib/board/requests.test.mjs`

**Interfaces:**
- Consumes: `boardWrite` (Task 4), `release` (Task 5, through `extraMutate`), `parseDoc` and `setFields` (Task 1), `safeExcerpt` (Task 7).
- Produces:
  - `newRequestId(now: Date, rand = Math.random) -> string`.
  - `buildRequest({ id, kind, gate?, scope, effort, phase, worker, for, blocking, now, sections: Record<heading, string> }) -> string`. This is the spec's frontmatter plus `answer: null`. The body sections come in the order Request, Context, Options, Assumption, Findings, Error, Answer (empty).
  - `validateRequest(text, filename) -> string[]` (problems):
    - the enums: `kind`, `scope`, `status`, `answered_via` ∈ `{cli, file, slack, null}`;
    - the id shape, and the filename matching `<id>.md`;
    - `Request` and `Context` are always required. `Options` is required for `question`, `Assumption` for `clarification`, `Error` for `error`, and `Findings` (with at least one `### F<n>`) for `gate: review-findings`;
    - `blocking: false` is allowed only for clarifications;
    - `status: answered` requires `answered_by`, `answered_at` and an `answer` consistent with the kind (a map of `F<n>` keys for review gates).
  - `listRequests(root) -> { requests: Request[], problems }`, where `Request = { id, path, fm, sections }`.
  - `postRequest(clone, req, { identity, workerId, releaseFrom?: { slug, claimant } }) -> { ok, id }`. It writes the file. When `req.blocking` and `releaseFrom` are both set, the same commit sets the feat-req's `awaiting: <id>` and clears its claim (kind `request`). The `Error` section is passed through `safeExcerpt` before the write.
  - `answerRequest(clone, id, { answer, notes, by, via, identity, now }) -> { ok: true } | { ok: false, reason: 'not-open' | 'missing' | 'invalid-answer' }`. It touches only `board/requests/<id>.md`, with `onReject: 'rebase'`; its `validate` re-checks that the answered file on main is ours.
  - `withdrawRequest(clone, id, { identity, workerId, slug, note }) -> result`. It deletes the file, clears `awaiting` if it points to this request, and appends `note` to the feat-req's `## Decisions`.
  - `answeredFor(root, slug) -> Request[]`: the answered requests for that effort.

- [x] **Step 1: Write the failing tests**

```js
test('newRequestId shape and sortability', () => {
  assert.match(newRequestId(new Date('2026-11-19T12:53:00Z')), /^202611191253-[a-z0-9]{6}$/);
});
test('every kind built by buildRequest validates clean', () => { /* gate, question, clarification, effort error, worker error, review gate */ });
test('validateRequest catches: bad id, filename mismatch, missing Options on a question, a non-blocking question, answered without answered_by', () => {});
test('postRequest blocking: one commit adds the file, sets awaiting, clears the claim', () => {
  // git show --name-only HEAD lists exactly the request file and the feat-req
});
test('postRequest clarification: no awaiting, claim kept', () => {});
test('postRequest redacts the Error section', () => {});
test('answerRequest touches only the request file and sets answered_* fields', () => {});
test('a second answer is rejected with not-open', () => {});
test('answering a missing request → missing, nothing pushed', () => {});
test('withdrawRequest removes the file, clears awaiting, logs the note', () => {});
test('listRequests reports a request with broken YAML in problems and skips it', () => {});
```

- [x] **Step 2: Run the tests and confirm they fail**

Run: `node --test scripts/lib/board/requests.test.mjs`
Expected: FAIL.

- [x] **Step 3: Implement the exports**

- [x] **Step 4: Run the tests and confirm they pass**

Run: `node --test scripts/lib/board/requests.test.mjs`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add scripts/lib/board/requests.*
git commit -m "feat(board): request files: build, validate, post, answer, withdraw"
```

### Task 9: Answer effects

**Files:**
- Create: `scripts/lib/board/effects.mjs`
- Test: `scripts/lib/board/effects.test.mjs`

**Interfaces:**
- Consumes: `setFields`, `appendToSection` (Task 1), `boardWrite` (Task 4), `holds` (Task 5), `buildRequest`, `newRequestId`, `answeredFor` (Task 8).
- Produces:
  - `applyAnswer(root, request, { now, claimant }) -> { paths: string[], agentInput: string | null, newRequests: object[] }`. It's pure over the working tree and doesn't commit. Every call appends `- <date> · <id> · <kind>: <answer> — <notes> (applied by <claimant>)` to the feat-req's `## Decisions`.
  - `applyAnswered(clone, slug, { claimant, identity, workerId, now }) -> { ok, agentInput: string[] }`. In one `apply` commit it applies every answered request for the effort, deletes their files, clears `awaiting`, and posts any `newRequests`. It runs `validate: holds(clone, slug, claimant)`.

| Case | Expected files after `applyAnswer` | `agentInput` |
|---|---|---|
| design `approve` | design `status: APPROVED`; feat-req `status: DESIGNED` | null |
| design `reject` | design stays `DRAFT`; feat-req stays `ACCEPTED` | notes |
| triage `accept` | feat-req `status: ACCEPTED` | null |
| triage `park` | `status: PARKED`; `## Triage` holds the reason | null |
| triage `reject` | `status: REJECTED`; `## Triage` holds the reason | null |
| review `{F1: fix, F2: accept}` | plan gains `### Review fixes (<id>)` with `- [ ] Fix review finding F1: <title> (request <id>)`; F2's rationale is in `## Decisions` | null |
| policy `approve` / `reject` | reject: feat-req status goes back one step in the lifecycle | approve: "proceed with the gated step"; reject: notes |
| question | — | the option letter or text, plus notes |
| clarification `correct`, plan not IMPLEMENTED | plan gains `- [ ] Rework (clarification <id>): <notes>` after the last checked step | null |
| clarification `correct`, feat-req IMPLEMENTED | new `docs/feat-req/<slug>-followup-<id>.md` (`status: ACCEPTED`, `source: Clarification <id> on <slug>`) and one triage gate in `newRequests` | null |
| effort error `park` / `retry` / text | park: `status: PARKED`, with `## Triage` reason = the error message | retry: "resume"; text: the instructions |
| worker error `resolved` | — (handled by the worker runtime) | null |

- [x] **Step 1: Write the failing tests**: one `test()` per row above, plus:

```js
test('applyAnswered: one apply commit, request files gone, awaiting cleared, Decisions cites each id', () => {});
test('applyAnswered pushes nothing if the claim is no longer held', () => {});
```

- [x] **Step 2: Run the tests and confirm they fail**

Run: `node --test scripts/lib/board/effects.test.mjs`
Expected: FAIL.

- [x] **Step 3: Implement `applyAnswer` and `applyAnswered`**

The plan file for a slug is `docs/plans/<slug>.md`, or the highest-numbered `<slug>-N.md` that isn't `IMPLEMENTED`.

- [x] **Step 4: Run the tests and confirm they pass**

Run: `node --test scripts/lib/board/effects.test.mjs`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add scripts/lib/board/effects.*
git commit -m "feat(board): apply answered requests (effects table)"
```

### Task 10: Worker registry and derived state

**Files:**
- Create: `scripts/lib/board/registry.mjs`
- Test: `scripts/lib/board/registry.test.mjs`

**Interfaces:**
- Consumes: `parseLog` (Task 3), `claimState` (Task 5), `listRequests` (Task 8).
- Produces:
  - `workerYaml({ id, owner, name, host, agent, model, created_at, retired_at = null }) -> string`
  - `readWorker(root, id) -> object | null`; `listWorkers(root) -> object[]`
  - `workerState(id, { worker, events, efforts, requests, now, ttlMs }) -> { state: 'retired' | 'needs-attention' | 'stopped' | 'working' | 'stale' | 'idle', effort: string | null, lastSeen: Date | null }`. The rules are checked in this order: retired → an open worker-scope error naming it → the last of start/stop/crash isn't `start` → holds a live claim → holds a stale claim → idle.
  - `boardView(root, { now, ttlMs }) -> { workers: [{...worker, ...state}], inbox: Record<for, Request[]>, inFlight: [{ slug, status, claimant, claimAgeMs, stale }] }`. Shared by `sdlc status`, `sdlc inbox` and `render-status`.

- [x] **Step 1: Write the failing tests**: one per state in the order above, plus a `boardView` test that groups the inbox by `for` (oldest first) and gives the in-flight rows a claimant, an age and a stale flag.

- [x] **Step 2: Run the tests and confirm they fail**

Run: `node --test scripts/lib/board/registry.test.mjs`
Expected: FAIL.

- [x] **Step 3: Implement the exports**

- [x] **Step 4: Run the tests and confirm they pass**

Run: `node --test scripts/lib/board/registry.test.mjs`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add scripts/lib/board/registry.*
git commit -m "feat(board): worker registry and derived worker state"
```

### Task 11: `sdlc` board commands

**Files:**
- Create: `scripts/sdlc.mjs`
- Create: `scripts/lib/board/cli.mjs`
- Test: `scripts/lib/board/cli.test.mjs`

**Interfaces:**
- Consumes: Tasks 2–10.
- Produces:
  - `run(argv: string[], { cwd, out: (s) => void, err: (s) => void, now: () => Date, whoami: () => { login, name, email }, sleep: (ms) => Promise }) -> Promise<number>` (the exit code). `scripts/sdlc.mjs` only calls `run(process.argv.slice(2), realDeps)` under `isEntryPoint`. The `worker` subcommand is dispatched to `scripts/lib/worker/cli.mjs` when it exists (Plan 2); until then it prints "workers arrive in a later release" and exits 2.
  - Commands, all run from a meta repo clone:
    - `check [--json]`: `validateConfig`, `validateRequest` over every request, and the registry files parse. It exits 1 on any problem and prints `file: problem`.
    - `next [--json]`: `rank` plus the overlap warnings. JSON shape: `{ next: Effort | null, overlaps: [...] }`.
    - `claim <slug>`, `report <slug> --phase <STATUS> [--paths a,b]` and `release <slug>`. The claimant is `whoami().login`. `report` commits the effort's docs (`docs/feat-req/<slug>.md`, `docs/design/<slug>.md`, `docs/plans/<slug>*.md`, the `docs/history/*_<slug>*.md` files changed since `origin/main`, plus `--paths`) with `Phase:` and a renewed lease. When the claim isn't held, it prints `<slug> is now held by <claimed_by>; nothing was pushed` and exits 3.
    - `status [--json]`: `boardView` rendered as three tables.
    - `inbox [--all] [--json]`: the requests whose `for` is the login or `approvers`; `--all` shows everyone's.
    - `answer <id> [--choice X] [--note "…"]`: interactive menus through `ui.mjs` when on a TTY with no `--choice`; otherwise flags are required. Review gates take `--choice F1=fix,F2=accept`. It sets `answered_via: cli`.
    - `watch [--interval 30s] [--json] [--since <sha>] [--max-polls N]`. `--max-polls` is for tests.
  - Every write command calls `assertOnMain` first.

- [x] **Step 1: Write the failing tests** (each one uses `makeBoard`, with stubs for `whoami`, `now` and `sleep`):

```js
test('check exits 1 and names a broken request file', () => {});
test('next --json ranks and reports overlaps', () => {});
test('claim / report / release round-trip; report carries Phase and renews the lease', () => {});
test('report after a takeover prints the warning, exits 3, pushes nothing', () => {
  assert.match(errOut, /bulk-export is now held by lidorl-1a2b3c; nothing was pushed/);
});
test('write commands refuse off main', () => {});
test('answer touches only the request file; second answer exits non-zero', () => {});
test('answer for a withdrawn request: "no such open request", exit 1', () => {});
test('inbox shows mine + approvers, oldest first; --all shows everyone', () => {});
test('watch --json --max-polls 2 prints each new event as one JSON line', () => {});
test('worker subcommand before Plan 2 exits 2 with a clear message', () => {});
```

- [x] **Step 2: Run the tests and confirm they fail**

Run: `node --test scripts/lib/board/cli.test.mjs`
Expected: FAIL.

- [x] **Step 3: Implement `cli.mjs` `run` and the `scripts/sdlc.mjs` entry**

Argument parsing is hand-rolled, like `assemble-env.mjs`. Colors come from `style.mjs` `colorEnabled(process.stdout)`.

- [x] **Step 4: Run the tests and confirm they pass**

Run: `node --test scripts/lib/board/cli.test.mjs`
Expected: PASS.

- [x] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, with no regression in the existing tests.

- [x] **Step 6: Commit**

```bash
git add scripts/sdlc.mjs scripts/lib/board/cli.*
git commit -m "feat(sdlc): board commands: check, next, claim, report, release, status, inbox, answer, watch"
```
