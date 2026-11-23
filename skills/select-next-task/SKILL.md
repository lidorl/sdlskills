---
name: select-next-task
description: Use to pick what to work on next — ranks all in-flight work and open feature requests in one queue, then routes the selection to the correct lifecycle phase.
---

**Board mode** (`board/` exists — see **Workers and the board** in `CLAUDE.process.md`): workers and other people share this queue, so take the pick from the board and claim before acting (Steps 1 and 6). A headless run skips this skill: the worker already chose and claimed.

### Step 1: Gather the queue

In board mode, run `node scripts/sdlc.mjs next --json`. It returns `{ next, overlaps }`: the single top pick (already skipping efforts someone else holds and efforts waiting on an answer) and any repo overlaps with efforts in flight. `next` is `null` when nothing is claimable: go to Step 2. Otherwise read that effort's docs as below and apply Step 3's user-override rule. If the user overrides it, or its claim is refused in Step 6, rank the rest by hand with the steps below.

Otherwise, collect every candidate from:

- `docs/feat-req/*.md` — read frontmatter. Include `status` in `{ACCEPTED, DESIGNED, PLANNED, IN_PROGRESS}`. Exclude `PARKED`, `REJECTED`, `IMPLEMENTED`.
- `docs/plans/*.md` — read frontmatter. Cross-reference to their feat-req; a plan with `status: IN_PROGRESS` marks its feat-req as in-flight.

Read the documents — do not rank on filenames alone.

### Step 2: If the queue is empty

- Run `/gather-open-items` in **full-sweep** mode — deferred Open Items across all design docs and implemented plans may promote to feat-reqs.
- If still empty, ask the user what to work on next and run `/write-feature-request`.

### Step 3: Rank (one unified queue)

Apply in strict order:

1. **User override** — an explicit instruction in the current prompt wins.
2. **Security / Critical** — any `severity: Critical` item, or one tagged security, ranks first. This applies across feat-reqs *and* in-flight plans equally.
3. **In-flight before new** — among non-critical items, an item already past `ACCEPTED` (has a design or plan started) outranks an untouched `ACCEPTED` feat-req. Finish what's open before starting more.
4. **Priority** — `High > Medium > Low`.
5. **Age** — oldest `date` first. A document missing a `date` is treated as oldest (fix it rather than letting it jump the queue).

### Step 4: Reconstruct the workspace

If the selected item's `status` is `DESIGNED`, `PLANNED`, or `IN_PROGRESS` and its design doc has a `repos:` list, run:

```
node scripts/assemble-env.mjs <slug>
```

This checks out `workspace/` for the effort. Report any mismatch warning it prints (workspace was assembled for another effort). Skip for `ACCEPTED` — there is no design doc yet.

### Step 5: Route to the phase

Based on the selected item's `status`:

| `status` | Next action |
|---|---|
| `ACCEPTED` | `/classify-change` (tier decision), then `/write-design-doc <name>` for standard tier |
| `DESIGNED` | `/write-execution-plan <name>` |
| `PLANNED` | Set feat-req + plan `status: IN_PROGRESS`, then enter Development — `superpowers:executing-plans` or `subagent-driven-development` per Autonomy Policy `implementation_checkpoints` |
| `IN_PROGRESS` | Resume Development from the plan's first unchecked step. Summarise cross-repo state from the plan's `## Pull Requests` table (`api merged, web open, …`). |

After Development completes, run `/close-out` (standard tier).

### Step 6: Present and confirm

Output:

- **Selected:** <name> (`status`, source file)
- **Rank reason:** which rule selected it
- **Next action:** the phase skill / command from Step 4

Then, per Autonomy Policy `task_selection`:

- `confirm` → ask for approval. If rejected, return to Step 3 with the next-ranked item.
- `auto` → state the selection and proceed. Stay interruptible.

Board mode, interactive: claim the selection before acting on it: `node scripts/sdlc.mjs claim <name>`.

- Exit `0`: you hold it. Proceed. When the next action sets a status (e.g. `PLANNED` → `IN_PROGRESS`), end it with `node scripts/sdlc.mjs report <name> --phase <status>`.
- The output says to run `gh auth login`: stop and tell the user; the claim needs their GitHub login.
- `not on main`: tell the user to switch the meta-root to `main` and run this skill again.
- Any other refusal (held by someone, awaiting an answer, closed): tell the user and rank the remaining candidates by hand (Step 1, "Otherwise").

### Constraints

- One queue. Do not rank feat-reqs and plans in separate pools.
- Deep-read each candidate for `status`, `priority`, `severity`, `date`.
- Never advance a `PARKED`/`REJECTED` feat-req without the user explicitly un-parking it.
