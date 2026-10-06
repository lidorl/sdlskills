# Pluggable doc store: scripts-based abstraction, no standing service

## Status
Accepted

## Context
[`docs/feat-req/pluggable-doc-store.md`](../feat-req/pluggable-doc-store.md) asks for git to become the default implementation of a doc-store abstraction, with JIRA + Confluence as the first alternate backend, including two-way content sync. The kit has no application code today (`CLAUDE.md`) and skills are markdown, agent-executed, holding no project state — any new logic has to fit that shape without turning the kit into a deployed service.

## Options Considered
- **Config-driven `doc-store.yml` + `scripts/lib/doc-store.mjs` abstraction, invoked via `scripts/sync-doc.mjs`.** Extends the existing skill → script → external-system pattern (`render-status.mjs`, `assemble-env.mjs`). `GitDocStore` is a true no-op so the default path is untouched; `JiraConfluenceDocStore` uses Node's built-in `fetch`, adding zero new runtime dependencies.
- **Per-artifact-type scripts hardcoded into each skill** (e.g. `write-feature-request` calls a JIRA-specific script directly, no shared interface). Faster to build for JIRA alone, but contradicts the feat-req's explicit ask for pluggability — a second backend would mean re-touching every skill.
- **A standing sync daemon / webhook listener** for near-real-time bidirectional sync. Requires a persistent process and a publicly reachable endpoint — turns "process + tooling only" into a deployed service, and the feat-req explicitly scopes sync to the kit's existing read/write points, not real-time.

Conflict handling was decided alongside this:
- **Hash/timestamp-based conflict detection** (chosen) — compare local content hash and remote `updatedAt` against last-synced values; flag and stop when both sides changed since the last sync.
- **Last-write-wins** — rejected; directly contradicts the feat-req's unhappy-path scenario (conflicts must be surfaced, not silently overwritten).
- **Full three-way text merge** — rejected for v1; meaningfully more complex for freeform markdown, and nothing in the acceptance criteria requires merging, only that a conflict is surfaced.

## Decision
Add a `doc-store.yml` (non-secret, committed, mirrors `repos.yml`'s role) selecting `git` (default) or `jira-confluence`. Backend logic lives in `scripts/lib/doc-store.mjs` behind a `GitDocStore` / `JiraConfluenceDocStore` interface, invoked by skills through a single `scripts/sync-doc.mjs push|pull <file>` CLI — the same shape as existing scripts. Conflict detection is hash/timestamp comparison against last-synced state (kept in a git-ignored sidecar, `workspace/.sync-state/`), not a merge engine: both-sides-changed always stops and asks a human.

## Consequences
- Adding a second alternate backend later means writing one more `DocStore` implementation, not touching every skill — the abstraction pays for itself the moment a second backend is considered.
- Zero new runtime dependency: Basic Auth + built-in `fetch` is sufficient for JIRA REST v3 / Confluence REST v2, preserving the kit's minimal-dependency convention.
- Sync is only as fresh as the last skill invocation that touched an artifact (no real-time push from JIRA/Confluence side). Acceptable per the feat-req's explicit scope; a future ADR would be needed to add webhook-driven sync.
- A genuine concurrent edit (both sides changed) always requires a human to reconcile and re-run `pull`/`push` — no automatic merge. If this proves disruptive in practice, three-way merge is the documented upgrade path, not a redesign.
