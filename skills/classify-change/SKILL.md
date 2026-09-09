---
name: classify-change
description: Use before starting any code change — decides the tier (trivial / standard / hotfix), which determines how much of the SDLC pipeline applies. Run right after a task is selected and before the Design phase.
---

Every code change is one of three tiers. This skill decides which, states the rule that decided it, and produces the justification line for the history entry.

Run this before touching code. If you are already mid-implementation and the change has grown, run it again (Step 5).

### Step 1: Hotfix check

Is a change that has **already shipped** causing a **live problem** right now (broken deploy, failing production behavior, bad migration)?

- Yes → `tier: hotfix`. Go to the Hotfix flow below.
- No → continue.

### Step 2: Hard carve-outs (never trivial)

The change is **standard** — regardless of size — if it touches any of:

- Authentication or authorization logic
- Data access control (who can read or write what)
- API surface: any endpoint, request/response shape, DTO, or external contract
- Database schema: any migration, table, column, index, or enum
- API-key generation or validation
- A new or removed dependency

If any applies: `tier: standard`, rule: `carve-out: <which>`.

### Step 3: Trivial test

If no carve-out applied, the change is **trivial** only if ALL hold:

- No observable behavior change for any user or caller
- Blast radius roughly ≤2 files and ≤20 lines
- No new dependency

Typical trivial changes: a typo in a log line or comment, tightening a type, a lint/format fix, a test-only change, a config default that does not change runtime behavior.

All hold → `tier: trivial`. Otherwise → `tier: standard`, rule: `<condition that failed>`.

### Step 4: Output and proceed

State, before any work:

- **Tier**
- **Rule** — the specific carve-out or condition that decided it
- **Justification** (trivial/hotfix) — one line for the `docs/history/` entry

Then:

- **trivial** → make the change, add tests if behavior-adjacent, write the history one-liner via `/write-history-entry`. No design doc, plan, review, or Open Items. Done.
- **standard** → enter Design: `/write-design-doc`.
- **hotfix** → Hotfix flow below.

### Step 5: Re-classify if a trivial change grows

If a trivial change turns out to touch a carve-out, exceed the blast radius, or introduce a behavior change:

1. Stop.
2. Re-run Steps 2–3 → result is `standard`.
3. Tell the user it was re-classified and why. Restart at Design.

---

## Hotfix flow

1. Make the **minimal** fix or revert. Nothing beyond what stops the bleeding.
2. Write tests that prove the fix and would have caught the regression.
3. Verify (`superpowers:verification-before-completion`).
4. `/write-history-entry` — include an `## Incident` section: what broke, when, root cause, why this fix works, blast radius.
5. File a **mandatory** follow-up feature request (`/write-feature-request`) for the proper fix / hardening. `source: Hotfix follow-up for <incident>`. This is not optional even if the hotfix looks complete.
6. If the incident touched a carve-out area (it usually does), run `/security-review`.

### Constraints

- Classify before coding. A classification produced after the change cannot gate the pipeline.
- "I think it's fine" is not a rule. Cite a specific carve-out or trivial-test condition.
- When uncertain between tiers, choose `standard`.
