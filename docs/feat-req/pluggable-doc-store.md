---
date: 2026-09-14
priority: Medium
severity: Low
status: PLANNED
source: User request
plans:
  - docs/plans/pluggable-doc-store-1.md
  - docs/plans/pluggable-doc-store-2.md
---

# Pluggable doc store: JIRA + Confluence as an alternate to git

## Problem & Context

The kit's artifacts (feature requests, design docs, plans, ADRs) currently live only as markdown files in git. This creates three problems: non-engineering stakeholders (PMs, leads) don't work in git and never see this output; many orgs already run their actual workflow and reporting through JIRA/Confluence, so git-only docs become a second, disconnected system of record; and there's no way to link kit work to pre-existing JIRA epics/tickets that already exist elsewhere in the org's backlog.

## Users & Personas

- **PM / stakeholder** — needs to see and track feature requests as JIRA epics/tickets and read design docs in Confluence, without opening the git repo.
- **Kit adopter / engineer** — runs the SDLC skills day to day; wants doc creation/sync to happen automatically as part of the existing workflow (`/write-feature-request`, `/write-design-doc`, etc.) without extra manual steps.
- **The agent** — needs to know, per artifact, where it's stored (git, JIRA, Confluence) and how to keep both sides in sync.

## Scenarios

- As a PM, I open JIRA and see a new Epic the moment a feature request is accepted, with the spec's acceptance criteria in its description, so I can track it in the tool my team already uses.
- As an adopter, I edit the epic description directly in JIRA (e.g. to fix a typo or add detail) and the next time the kit touches that feature request, my edit is reflected in the local file, so stakeholder edits aren't lost.
- As an engineer, I run `/write-execution-plan` and each task becomes a JIRA Story/Sub-task under the feature's Epic, so plan progress is trackable from JIRA without reading git.
- As an adopter, I run `/write-design-doc` and get a Confluence page, linked from the Epic, so design review happens where my team already reviews docs.
- As an adopter using the kit today with git-only docs, I don't configure a JIRA/Confluence store, so nothing changes for me — doc storage remains git exactly as before.
- As an adopter, I switch on the JIRA/Confluence store for a repo that already has git-committed docs — nothing is auto-migrated. New artifacts go to JIRA/Confluence; old ones remain in git as historical record. I can optionally run a migration tool if I want them moved.
- **Unhappy path:** a JIRA/Confluence API call fails (auth, network, rate limit) → the local git file remains the source of truth and is not lost; the agent surfaces the failure and retries/asks rather than silently dropping the write.
- **Unhappy path:** the same artifact is edited both locally and in JIRA/Confluence before a sync runs → the agent detects the conflict and asks rather than silently overwriting either side.

## In Scope

- A doc-store abstraction in the kit, with git as the default/existing implementation.
- A JIRA + Confluence implementation of that abstraction as the first alternate store, configured per-adopter at setup time (one store per artifact, not simultaneous).
- Artifact mapping:
  - Feature Request → JIRA Epic (spec content, including acceptance criteria, in the description).
  - Plan tasks → JIRA Stories/Sub-tasks under the Epic.
  - Design Doc → Confluence page, linked from the Epic.
  - ADR → Confluence page.
  - History Entry → stays git-only.
- Status sync: `status` (ACCEPTED/DESIGNED/PLANNED/IN_PROGRESS/IMPLEMENTED/etc.) is derived from JIRA ticket/epic transitions rather than hand-set frontmatter, for adopters on this store.
- Two-way content sync: edits made directly in JIRA/Confluence are pulled back into the local file; edits made locally are pushed out. Conflicts (both sides changed) are detected and surfaced, not silently resolved.
- Credential/connection configuration for JIRA + Confluence (API token, project key, Confluence space), wired through the setup flow.
- An optional, non-blocking one-time migration/backfill tool to push existing git-committed docs into JIRA/Confluence for adopters who want it.

## Out of Scope

- Any doc-store backend other than git and JIRA/Confluence (the abstraction should allow future backends; building another one is not part of this request).
- Making migration of existing docs mandatory or automatic.
- Replacing git as the *code* repository — this is about kit docs only, not source code.
- Real-time/instant sync guarantees (e.g. webhook-driven push-on-edit) — sync happens at the kit's existing read/write points unless design decides otherwise.

## Acceptance Criteria

- [ ] An adopter can configure the JIRA/Confluence store during setup and the kit confirms the connection works.
- [ ] Running `/write-feature-request` with the store enabled creates/updates a JIRA Epic containing the spec content, on triage ACCEPTED.
- [ ] Running `/write-design-doc` with the store enabled creates/updates a linked Confluence page.
- [ ] Running `/write-execution-plan` with the store enabled creates JIRA Stories/Sub-tasks per task, linked to the Epic.
- [ ] `select-next-task` / `render-status.mjs` reflect status derived from JIRA transitions for artifacts on this store, without manual frontmatter edits.
- [ ] An edit made directly in JIRA/Confluence is reflected back into the local git file the next time the kit touches that artifact.
- [ ] A conflicting edit (both local and remote changed since last sync) is surfaced to the user rather than silently overwritten.
- [ ] An adopter with no JIRA/Confluence configuration sees no change in behavior — the git-backed flow works exactly as it does today.
- [ ] A failed JIRA/Confluence API call does not lose or corrupt the local git file.

## Success Metrics

- A PM/stakeholder can track a feature's full lifecycle (Epic → Stories → status) from JIRA alone, without opening the git repo.
- Zero reports of local docs being silently overwritten or lost due to a sync conflict.
- Adopters who don't configure the store see zero behavior change (regression-free for the existing git-only path).

## Constraints & Dependencies

- **Dependencies:** JIRA + Confluence API access (Atlassian Cloud REST APIs), a project/space to point at, and a way to store credentials outside of git.
- **Constraints:** The abstraction must not force git-only adopters to take on any new dependency, config, or behavior change. Sync must degrade safely (local file wins) when the network/API is unavailable.

## Open Questions

- What conflict-resolution strategy applies when both the local file and the JIRA/Confluence content changed since the last sync (design must specify: last-write-wins, three-way merge, hard stop for human resolution)?
- Where/how are JIRA/Confluence credentials stored and scoped (per-adopter, per-repo, per-multi-repo-effort)?
- Is a JIRA Epic created for a feature request as soon as triage is ACCEPTED, or lazily on first touch after acceptance? What happens to PARKED/REJECTED requests — no Epic at all, or one that reflects the parked/rejected state?
- Does the multi-repo execution environment (`repos.yml`) interact with this — e.g. can different repos in one effort point at different JIRA projects, or is the store one config per meta-root?
- Exact field mapping between kit frontmatter (priority, severity, status, repos, feat_req/design links) and JIRA/Confluence fields (issue type, labels, epic link, custom fields).
- Does History Entry ever need any JIRA visibility (e.g. worklog/comment), or is "stays git-only" final?

## Solution Direction

A `DocStore` interface the kit's skills write through, with a `GitDocStore` (current behavior, default) and a `JiraConfluenceDocStore` implementation. Configured once during `/setup-sdlc` (or a follow-up setup step) per adopter. Sync happens at the kit's existing read/write points (skill invocations), not via a standing background service.
