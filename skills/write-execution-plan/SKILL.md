---
name: write-execution-plan
description: Use after a design doc is APPROVED and before Development — wraps superpowers:writing-plans to produce the execution plan in docs/plans/, stamped with the frontmatter that select-next-task and gather-open-items rely on.
---

The Plan phase turns an approved design into an ordered, executable sequence. This skill is a thin wrapper around `superpowers:writing-plans` that enforces location, frontmatter, and state.

### Step 1: Verify the design is ready

- Locate the design doc in `docs/design/<name>.md` for this feature.
- Its frontmatter `status` must be `APPROVED`. If `DRAFT`, stop — the design needs approval first (`/write-design-doc`).
- The linked feat-req `status` must be `DESIGNED`.

### Step 2: Write the plan

- Invoke `superpowers:writing-plans` with the design doc as the spec/requirements input.
- Plans go in **`docs/plans/`** — this overrides `writing-plans`' default location. If it wrote elsewhere, move the file.
- Filename matches the feature: `docs/plans/<name>.md` (same `<name>` as the feat-req and design doc).

### Step 3: Stamp frontmatter

Ensure the plan file's frontmatter includes:

```markdown
---
feat_req: docs/feat-req/<name>.md
design: docs/design/<name>.md
status: PLANNED
date: YYYY-MM-DD
---
```

Every task in the plan body starts as an unchecked `- [ ]`.

### Step 4: Advance state

- Set the feat-req `status: PLANNED`.
- Run `scripts/render-status.mjs` (or note the `Stop` hook will).
- Tell the user the next phase is Development. Per the Autonomy Policy `implementation_checkpoints`: `pause` → `superpowers:executing-plans` (checkpoints between phases); `run-through` → `superpowers:subagent-driven-development` or `executing-plans` with checkpoints auto-acknowledged and logged.

### Constraints

- One plan per feature by default. If the design genuinely needs multiple plans, name them `<name>-1.md`, `<name>-2.md` and link all from the feat-req; the feat-req `status` advances only when all are `IMPLEMENTED`.
- Do not start implementing here. Stop after Step 4.
- Do not re-do design work. If planning surfaces a design gap, stop and return to `/write-design-doc`.
