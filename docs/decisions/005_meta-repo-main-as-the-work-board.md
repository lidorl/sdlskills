# The meta repo's main branch as the work board, with per-worker clones

## Status
Accepted (amends [001](001_meta-root-with-git-ignored-workspace.md))

## Context
The kit is moving from one interactive worker to many workers, running in parallel on several machines ([`docs/feat-req/workers.md`](../feat-req/workers.md)). They need one place to coordinate who holds which effort, to report progress and to post requests to people, without adding a service. ADR 001 gave each meta-root a single `workspace/` with a `.current-effort` marker, and named per-effort directories as the upgrade path once parallel work arrived.

## Options Considered
- **A separate `board` branch.** It keeps main free of event commits and is compatible with branch protection. But effort artifacts live on main, so claims would race them across two branches.
- **GitHub Issues or the API as the board.** It brings notifications and access control for free, but ties the protocol to one host's API and rate limits, and moves state out of the repo the skills read.
- **Main as the board** (chosen). Claims, reports and requests are small commits on main. A claim counts only once it's on `origin/main` and validated after a fresh pull. Rejected pushes restart the claim, and nothing is ever force-pushed.
- **Per-effort `workspace/<effort>/` dirs in one shared clone** (ADR 001's upgrade path). Several workers would share one git index and race each other's commits.
- **Per-worker meta clones** (chosen). Each worker has its own home (`~/.sdlc/workers/<id>/meta/`) and holds one effort at a time, so ADR 001's single `workspace/` and `.current-effort` stay correct inside each clone.

## Decision
The meta repo's `main` branch is the work board, and the commit log, through fixed subjects and trailers, is its event stream. Each worker gets its own clone of the meta repo, and ADR 001's layout holds unchanged inside it. Board mode is opt-in per meta repo: it's on when `board/` exists, so a solo meta-root behaves as before.

## Consequences
- Workers must be allowed to push to main directly, so a main protected by required PRs blocks the protocol. Adopters should still forbid force-push.
- Main's history gains board commits (claims, renewals while working, reports, requests, start and stop). There are no heartbeats, so an idle worker's liveness isn't visible on the board.
- Disk cost is one meta clone plus workspace per worker. Two workers on the same effort's repos hold separate checkouts.
- ADR 001's "per-effort dirs" upgrade path is superseded by per-worker clones.
- Any future client (control app, Slack bridge) reads and writes the same files and commits. The board format is the contract.
