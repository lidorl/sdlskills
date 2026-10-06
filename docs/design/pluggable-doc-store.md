---
feat_req: docs/feat-req/pluggable-doc-store.md
date: 2026-09-14
status: APPROVED
repos: [sdlskills]
---

# Pluggable doc store: JIRA + Confluence as an alternate to git

## Context

Today `docs/` artifacts (feat-req, design, plans, ADRs) live only as markdown files in git; `status` frontmatter is the single source of truth for lifecycle position (see `docs/design/architecture.md`). [`docs/feat-req/pluggable-doc-store.md`](../feat-req/pluggable-doc-store.md) asks for git to become the *default* implementation of a pluggable doc-store abstraction, with JIRA + Confluence as the first alternate: feature requests → Epics, plan tasks → Stories/Sub-tasks, design docs and ADRs → Confluence pages, status derived from JIRA transitions, two-way content sync with surfaced (not auto-resolved) conflicts.

Constraints that bound the solution:
- **No application code today.** This repo is process + tooling only (`CLAUDE.md`). This is the first feature that talks to an authenticated external service — it must not turn the kit into something that needs a running/deployed service to function.
- Skills are markdown, agent-executed, and vendored into adopters' `.claude/skills/` — they hold no project state (`docs/design/architecture.md`, Layers). Any new logic belongs in `scripts/`, following the existing skill → script → external-system pattern already used by `render-status.mjs` / `assemble-env.mjs`.
- `package.json` has exactly one dependency (`yaml`) today — minimal-dependency is an established convention, not stated as a hard rule but worth preserving where possible.
- Adopters who don't configure the store must see zero behavior change (feat-req Acceptance Criteria).
- Sync happens at the kit's existing read/write points (skill invocations) — no standing service, no webhooks (feat-req Out of Scope).
- The feat-req explicitly rejects silently overwriting either side on conflict.

## Proposed Design

### 1. Config: `doc-store.yml` (new, committed, meta-root)

Mirrors `repos.yml`'s role: a committed, non-secret catalog. Absent, or `store: git`, means zero behavior change — every skill's existing git-only flow runs exactly as today.

```yaml
store: git   # git | jira-confluence
jira:
  base_url: https://<org>.atlassian.net
  project_key: KIT
  issue_types: { epic: Epic, story: Story, subtask: Sub-task }
confluence:
  base_url: https://<org>.atlassian.net/wiki
  space_key: KIT
auth:
  email_env: JIRA_EMAIL          # name of the env var holding the adopter's Atlassian account email
  token_env: JIRA_API_TOKEN      # name of the env var holding the API token — never written to this file
```

The token itself is never persisted to any tracked file. `/setup-sdlc` gains an optional step: ask whether to configure a store; if yes, write `doc-store.yml`, prompt for the two env vars to be set in the adopter's shell/CI secrets, and verify the connection with `GET /rest/api/3/myself`. Declining leaves `store: git` (or no file at all — same effect).

### 2. `scripts/lib/doc-store.mjs` — the abstraction

```
getDocStore(config) → GitDocStore | JiraConfluenceDocStore
```

Both implement the same interface:

- `push(artifactType, { frontmatter, title, body, remoteId })` → creates or updates the remote object; returns `{ remoteId, url }`.
- `pull(remoteId)` → returns `{ body, status, updatedAt }` for the current remote state.
- `mapStatus(kitStatus)` / `mapRemoteStatus(jiraStatus)` → the two-way status translation table (see below).

`GitDocStore`'s methods are no-ops — the file already *is* the artifact — so the git-only path pays zero cost. `JiraConfluenceDocStore` uses Node's built-in `fetch` with HTTP Basic Auth (`email:token`) against the JIRA REST v3 and Confluence REST v2 APIs. **No new runtime dependency** — `fetch` is built into the Node versions this kit already targets.

### 3. `scripts/sync-doc.mjs` — the CLI entry point skills shell out to

```
node scripts/sync-doc.mjs push <file>
node scripts/sync-doc.mjs pull <file>
```

Reads `doc-store.yml`, reads the target file's frontmatter, calls the configured store, and writes the result back into frontmatter: `jira_key` (feat-req/plan tasks), `confluence_page_id` (design/ADR), plus sync-state fields (§4). Exits `0` immediately, no-op, when `store: git`. Exits non-zero with a clear message on a detected conflict or a failed API call — the calling skill surfaces this to the user rather than proceeding.

### 4. Conflict detection

Sync state (`synced_hash`, `remote_updated_at`) is tracked per artifact in a git-ignored sidecar, `workspace/.sync-state/<artifact-path>.json` (not in the file's own frontmatter, to keep human-read docs clean — see Open Items). On `pull`:

- Compute `sha256` of the current local body; compare to the stored `synced_hash`.
- Compare the remote's `updatedAt` to the stored `remote_updated_at`.
- Neither changed → nothing to do.
- Only one side changed → propagate it (pull into local file, or push local to remote), update both stored values.
- **Both changed → conflict.** `sync-doc.mjs pull` exits non-zero; the skill stops and asks the user to reconcile manually, then re-run `pull` (or `push` to force local as the resolution).

### 5. Status mapping

A fixed default table (overridable in `doc-store.yml` per org's workflow):

| Kit `status` | JIRA status |
|---|---|
| `ACCEPTED` | To Do |
| `DESIGNED` / `PLANNED` | To Do |
| `IN_PROGRESS` | In Progress |
| `IMPLEMENTED` | Done |

Push sets the JIRA status on a kit-side transition. Pull reads the JIRA status; if a human moved the ticket forward (e.g. `In Progress` → `Done` directly in JIRA), the kit adopts that on next `pull` rather than fighting it — this **is** the "status derived from JIRA transitions" behavior the feat-req asks for.

### 6. Skill integration points (one new step each, only when `store` ≠ `git`)

| Skill | New step |
|---|---|
| `write-feature-request` | After triage `ACCEPTED`: `sync-doc.mjs push` → creates the Epic, writes `jira_key`. |
| `write-design-doc` | After Step 6 approval: `sync-doc.mjs push` → creates the Confluence page, writes `confluence_page_id`; linked from the Epic. |
| `write-execution-plan` | After the plan is written: push each task as a Story/Sub-task under the feat-req's `jira_key`. |
| `select-next-task` | Before ranking: `sync-doc.mjs pull` for every candidate that has a `jira_key`, so remote status/content edits are folded in before the queue is ranked. |
| `close-out` | On `IMPLEMENTED`: final `push` to transition the Epic/Stories to Done. |
| `render-status.mjs` | Reads whatever `status` is currently in frontmatter — unchanged; it relies on `select-next-task`'s pull to have already synced it. |

### 7. Migration tool (optional, feat-req: not required)

`scripts/migrate-docs-to-store.mjs` — adopter-invoked, one-time, never run automatically. Walks `docs/feat-req`, `docs/design`, `docs/plans`, `docs/decisions` and `push`es each, populating `jira_key`/`confluence_page_id` on existing docs. Out of scope for the acceptance criteria; see Rollout & Migration.

## Data Model & Schema Changes

No database. Frontmatter additions:
- `docs/feat-req/*.md`, `docs/plans/*.md`: optional `jira_key: <ISSUE-KEY>`.
- `docs/design/*.md`, `docs/decisions/*.md`: optional `confluence_page_id: <ID>`.

New committed file: `doc-store.yml` (meta-root, template shipped by `install-sdlc.mjs`, non-secret). New git-ignored sidecar directory: `workspace/.sync-state/` (per-artifact sync state — hashes and timestamps, not content).

## API Surface Changes

The kit exposes no API. It **consumes** two external APIs for the first time:
- JIRA REST API v3 (`/rest/api/3/*`) — issue create/update/transition, scoped to the configured `project_key`.
- Confluence REST API v2 (`/wiki/api/v2/*`) — page create/update, scoped to the configured `space_key`.

Both authenticated via HTTP Basic Auth with an adopter-supplied Atlassian account email + API token (env vars, never committed). No new endpoints of the kit's own.

## Repositories in Scope

N=1. `sdlskills` owns the entire change:
- New: `scripts/lib/doc-store.mjs`, `scripts/sync-doc.mjs`, `scripts/migrate-docs-to-store.mjs`, `doc-store.yml` template.
- Modified: `write-feature-request`, `write-design-doc`, `write-execution-plan`, `select-next-task`, `close-out`, `setup-sdlc` skills; `install-sdlc.mjs` (vendors the new scripts + template); `.gitignore` (add `workspace/.sync-state/`).

## UI/UX Changes

None — no application UI. (The JIRA/Confluence pages themselves are the stakeholder-facing surface, but no UI code is built by the kit.)

## Alternatives Considered

**Abstraction shape — how skills reach the store:**
- **Chosen: config-driven `doc-store.yml` + a `scripts/lib/doc-store.mjs` abstraction (`GitDocStore` / `JiraConfluenceDocStore`), invoked via a single `scripts/sync-doc.mjs` CLI.** Extends the kit's existing skill → script → external-system pattern with one new concept. `GitDocStore` is a true no-op, so the default path is unaffected.
- **Rejected — per-artifact-type scripts called directly by each skill, no central abstraction** (e.g. a `jira-epic.mjs` hardcoded into `write-feature-request`). Faster to build for JIRA alone, but hardcodes the backend into each skill — contradicts the feat-req's explicit ask for a pluggable interface, and a second backend later would mean re-touching every skill again.
- **Rejected — a standing sync daemon / webhook listener** for near-real-time bidirectional sync. Requires a persistent process and a publicly reachable webhook endpoint, which turns "process + tooling only" into a deployed service. The feat-req explicitly scopes sync to the kit's existing read/write points, not real-time — this is out of proportion to v1's need. See ADR-005.

**Credential storage:**
- **Chosen: non-secret config (`doc-store.yml`) + env vars for the token/email**, following the same split as `repos.yml` (structured, committed) vs. secrets (never committed).
- **Rejected — OS keychain integration (e.g. `keytar`)**. Most secure, but adds a native, platform-specific dependency the kit doesn't need elsewhere and adopters already have a secrets mechanism (shell env / CI secrets) for everything else.

**Conflict handling:**
- **Chosen: hash/timestamp-based conflict *detection*** — compare local content hash and remote `updatedAt` against last-synced values; flag and stop when both changed.
- **Rejected — last-write-wins.** Directly contradicts the feat-req's unhappy-path scenario (conflicting edits must be surfaced, not silently overwritten).
- **Rejected — full three-way text merge.** Would handle partial concurrent edits more gracefully, but is meaningfully more complex to get right for freeform markdown, and nothing in the feat-req's acceptance criteria requires merging — only that a conflict is surfaced. Deferred; revisit if manual reconciliation proves too disruptive in practice.

See [`docs/decisions/005_pluggable-doc-store-via-scripts.md`](../decisions/005_pluggable-doc-store-via-scripts.md) for the recorded decision.

## Testing Strategy

- `scripts/lib/doc-store.mjs`, `scripts/sync-doc.mjs`: unit tests with `node:test`, mocking global `fetch` (no real API calls), following the existing convention (`assemble-env.test.mjs`, `render-status.test.mjs`).
  - `GitDocStore` push/pull are true no-ops → covers AC "no configuration, no behavior change."
  - `JiraConfluenceDocStore` push creates/updates via mocked `fetch`; asserts request shape (auth header, project/space key, issue/page payload) → covers Epic/Story/Confluence-page ACs.
  - Conflict detection: table-driven tests over (local changed?, remote changed?) × 4 → covers the conflict-surfaced AC and the two clean-propagation paths.
  - A failed `fetch` (mocked rejection / non-2xx) → asserts the local file is untouched and the script exits non-zero → covers the "no data loss on API failure" AC.
- `install-sdlc.test.mjs`: extend to assert the new scripts + `doc-store.yml` template are vendored.
- No integration test against a real JIRA/Confluence instance in CI (no such instance is available); manual verification against a real sandbox project is part of Close-out for this effort.

## Rollout & Migration

- Opt-in only: no `doc-store.yml`, or `store: git`, is behaviorally identical to today. No flag beyond this config value.
- `/setup-sdlc` gaining the optional config step is the only change existing adopters see, and only if they choose to answer it.
- `scripts/migrate-docs-to-store.mjs` is adopter-invoked and never run automatically — existing git-committed docs are untouched unless the adopter explicitly runs it.

## Security Considerations

- New external network calls with a real credential — this is the "API-key logic" + "new external endpoint" trigger for `/security-review` (run it for this effort before close-out).
- The API token is never written to a tracked file — `doc-store.yml` holds only the env-var *names*; `install-sdlc.mjs`'s `.gitignore` wiring is checked to ensure any local `.env` an adopter uses is already ignored.
- Recommend (in setup instructions, not enforced by code) that the adopter's API token be scoped to only the configured project/space.
- Sync failures fail closed: a failed push/pull never partially writes the local file or leaves frontmatter in an inconsistent state (write happens only after a successful round-trip).

## Open Items

- [ ] Confirm exact JIRA issue-type and transition names against a real target project during implementation — org workflow schemes vary; the default table in §5 may need to become fully configurable rather than a fixed default.
- [ ] Sync state currently proposed as a git-ignored sidecar (`workspace/.sync-state/`) rather than frontmatter, to keep docs human-clean — confirm this holds up once `select-next-task`'s pull-before-rank (§6) is implemented, since sidecar state must survive `clean-env.mjs` / workspace resets.
- [ ] Whether `/setup-sdlc`'s new step is asked of every adopter (declinable) or only offered when the adopter mentions JIRA/Confluence during the interview — deferred to the plan.
- [ ] `scripts/migrate-docs-to-store.mjs` (§7) may warrant its own follow-up plan rather than shipping in the same effort as the core sync path, given it's optional and non-blocking.
