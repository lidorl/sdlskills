---
name: gather-open-items
description: Use to reconcile Open Items left in design docs and implemented plans against what has actually shipped — resolving them in place or promoting them to feature requests. Runs scoped (one feature, at close-out) or full-sweep (everything, on demand or when the task queue is empty).
---

Two modes. `/close-out` invokes **scoped**. `select-next-task` invokes **full-sweep** when the queue is empty; the user can also invoke it directly.

---

## Scoped mode

Argument: one feature name. Reconcile only that feature's design doc `## Open Items`.

For each item, apply the **promote/defer rule**:

- **Promote to a feature request now** (`/write-feature-request`, referencing the source design doc) if it is:
  - (i) a known correctness or security gap, or
  - (ii) blocks a stated near-term feature, or
  - (iii) small and well-understood enough that filing costs less than re-deriving it later.
- **Otherwise** leave it in place with a one-line deferral rationale appended.

Mark promoted items `[EXTRACTED TO FEAT-REQ: <path>]` in the design doc.

---

## Full-sweep mode

### Step 1: Collect items

- `docs/design/*.md` — every `## Open Items` / "Next Steps" / "Future Work" / "TODO" section. Note source file.
- `docs/plans/*.md` with frontmatter `status: IMPLEMENTED` — lingering unchecked `- [ ]` or documented follow-ups. Note source file.
- `docs/feat-req/*.md` with `status: PARKED` — re-evaluate whether the parking condition still holds.

### Step 2: Check current status

For each item, determine if it is already handled, checking in this order (stop at the first that answers):

1. **Git log** — `git log --grep="<keyword>"`, `git log -S"<symbol>"`.
2. **architecture.md / data-model.md** — updated to reflect it?
3. **Design docs** — documented as done elsewhere?
4. **History entries** (`docs/history/`) — recorded as implemented?
5. **Codebase scan** (last resort) — search the actual code.

Then check `docs/feat-req/` for an existing request covering it.

### Step 3: Resolve

- **Already done** → edit the source doc: `- [ ]` → `- [x]`, or append `[RESOLVED <date>]`.
- **Not done, meets the promote/defer rule** → `/write-feature-request` (transfer full context, link the source doc), mark `[EXTRACTED TO FEAT-REQ: <path>]` in the source.
- **Not done, does not meet the rule** → leave with a deferral rationale.
- **PARKED feat-req whose condition now holds** → note it for the user to un-park (do not un-park unilaterally).

### Step 4: Summary

- **Scanned:** N design docs, N implemented plans, N parked feat-reqs.
- **Resolved in place:** list with source files.
- **Promoted to feat-reqs:** list with one-line descriptions.
- **Deferred:** count.
- **Parked items to review:** list for the user.

Run `scripts/render-status.mjs` at the end.

### Constraints

- Follow the Step 2 verification order — do not jump to a code scan while earlier sources are unchecked.
- Every promoted feat-req links back to its source doc and carries the full original context.
- Check for a duplicate feat-req before creating one.
