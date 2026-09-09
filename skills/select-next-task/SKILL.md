---
name: select-next-task
description: Use to pick what to work on next — ranks all in-flight work and open feature requests in one queue, then routes the selection to the correct lifecycle phase.
---

Single-worker model: this skill assumes one agent pulling from one queue. (Parallel execution is a deferred kit open item.)

### Step 1: Gather the queue

Collect every candidate from:

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

### Step 4: Route to the phase

Based on the selected item's `status`:

| `status` | Next action |
|---|---|
| `ACCEPTED` | `/classify-change` (tier decision), then `/write-design-doc <name>` for standard tier |
| `DESIGNED` | `/write-execution-plan <name>` |
| `PLANNED` | Set feat-req + plan `status: IN_PROGRESS`, then enter Development — `superpowers:executing-plans` or `subagent-driven-development` per Autonomy Policy `implementation_checkpoints` |
| `IN_PROGRESS` | Resume Development from the plan's first unchecked step |

After Development completes, run `/close-out` (standard tier).

### Step 5: Present and confirm

Output:

- **Selected:** <name> (`status`, source file)
- **Rank reason:** which rule selected it
- **Next action:** the phase skill / command from Step 4

Then, per Autonomy Policy `task_selection`:

- `confirm` → ask for approval. If rejected, return to Step 3 with the next-ranked item.
- `auto` → state the selection and proceed. Stay interruptible.

### Constraints

- One queue. Do not rank feat-reqs and plans in separate pools.
- Deep-read each candidate for `status`, `priority`, `severity`, `date`.
- Never advance a `PARKED`/`REJECTED` feat-req without the user explicitly un-parking it.
