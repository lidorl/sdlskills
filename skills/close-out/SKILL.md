---
name: close-out
description: Use when a standard-tier feature's implementation and review are done — walks the Definition of Done item by item, updates consumer-facing docs, reconciles Open Items, and flips status to IMPLEMENTED. The final lifecycle phase.
---

Close-out is where a mostly-autonomous pipeline lands cleanly or leaves half-done obligations. Work this checklist in order and report each item explicitly in the output.

### Step 1: Verify completion

Run `superpowers:verification-before-completion`. Tests pass, evidence recorded. If anything fails, stop — the feature is not ready for close-out.

### Step 2: History entry

If not already written, run `/write-history-entry` now (Deviations / Discoveries / Decisions / Step Status / Verification).

### Step 3: Consumer-facing documentation

Update anything a consumer reads, or record "no consumer-facing impact":

- README — if how to run or use the project changed
- API docs / OpenAPI descriptions — if the API surface changed
- Public changelog — if the project keeps one
- User guides / help text

### Step 4: Reconcile Open Items (scoped)

For each item in this feature's design doc `## Open Items`:

- **Promote to a feature request now** (`/write-feature-request`, `source: Extracted from docs/design/<name>.md`) if it is:
  - (i) a known correctness or security gap, or
  - (ii) blocks a stated near-term feature, or
  - (iii) small and well-understood enough that filing costs less than re-deriving it later.
- **Otherwise** leave it in the design doc with a one-line rationale for deferring.

Mark promoted items `[EXTRACTED TO FEAT-REQ: <path>]` in the design doc.

### Step 5: Walk the Definition of Done

Go through the Definition of Done checklist in `CLAUDE.process.md` item by item. For each, state: met / not-applicable (+ why) / not-met. If any item is not-met, stop and resolve it.

Include the Security Review item explicitly: either `/security-review` was run (link findings) or the design doc records "no security-relevant changes."

### Step 6: Flip state

- Feat-req `status: IMPLEMENTED`.
- Plan `status: IMPLEMENTED` (verify all `- [ ]` are checked first — if not, close-out is premature).
- Design doc stays `APPROVED`.

### Step 7: Refresh status

Run `scripts/render-status.mjs` (or note the `Stop` hook will). Report the final DoD walk and any feat-reqs created in Step 4.

### Constraints

- Do not flip `status: IMPLEMENTED` before Step 5 passes clean.
- Every DoD item gets an explicit verdict in the output — "looks done" is not a verdict.
- Trivial and hotfix tiers do not use this skill (trivial: history one-liner is the whole close-out; hotfix: `/classify-change` Hotfix flow covers it).
