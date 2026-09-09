---
name: write-design-doc
description: Use after a feature request is accepted and before writing an execution plan — produces the design doc in docs/design/ describing what will be built and how, with the fixed section structure that gather-open-items and select-next-task rely on.
---

When instructed to write, create, or update a design doc — or when moving a feature request into the Design phase — follow these steps exactly.

### Step 1: Locate the source feature request

- Find the feature request this design serves in `docs/feat-req/`. If the user named one, use it. Otherwise ask which — do not proceed without one.
- The feat-req `status` must be `ACCEPTED`. If it is `PARKED`/`REJECTED`, stop and ask.
- Read it in full: Problem & Context, Users & Personas, Scenarios, In/Out of Scope, Acceptance Criteria, Constraints, Open Questions.
- The design doc filename is the feat-req filename (feat-reqs have no state prefix). `docs/feat-req/offer-caps.md` → `docs/design/offer-caps.md`.

### Step 2: Understand the current system

- Read `docs/design/architecture.md` and `docs/design/data-model.md` if they exist.
- Trace the code paths the change will touch. Understand how the relevant feature works today before proposing changes.
- Note every module, table, and API surface the change affects — you must account for all of them in Step 4.

### Step 3: Technical brainstorm (conditional)

If the solution space is non-obvious — the feat-req's Solution Direction is one of several viable approaches, or there's a real architectural fork (e.g. event sourcing vs. audit table vs. temporal columns) — diverge before locking the doc's structure. Check the Autonomy Policy in `CLAUDE.process.md`:

- `technical_brainstorm: discuss` → run `superpowers:brainstorming`, then continue.
- `technical_brainstorm: solo` → generate 2–3 approaches yourself, evaluate each against the spec and constraints, pick one with written rationale, and carry the rejected approaches into **Alternatives Considered**. Proceed without a gate — Step 6 approval is the backstop.

Skip this step when the approach is clear (e.g. "add a `deleted_at` column").

### Step 4: Write the design doc

Create `docs/design/<name>.md` with this exact structure. Keep every heading, in order, even if short — downstream skills parse these anchors.

```markdown
---
feat_req: <path to source feat-req>
date: YYYY-MM-DD
status: DRAFT
---

# <Title — match the feat-req title>

## Context
What exists today, what the feat-req asks for, and the constraints that bound the solution. Link the feat-req.

## Proposed Design
The change, concretely: new/modified modules, control flow, how the pieces fit. Enough that the execution plan can be written from this section alone.

## Data Model & Schema Changes
Every table, column, index, enum, or migration this adds or alters. `None` if there are no schema changes.

## API Surface Changes
Every endpoint, request/response shape, DTO, or contract this adds or alters, and which auth guard applies. `None` if there are no API changes.

## UI/UX Changes
Screens/flows this adds or alters, and the `docs/design/STYLE_GUIDE.md` sections they must conform to. `None` if not applicable.

## Alternatives Considered
Each option weighed and why it was rejected. If any choice has cross-feature or long-lived architectural consequence, record it as an ADR in `docs/decisions/` and link it here.

## Testing Strategy
What will be tested and at what level (unit / integration), which Acceptance Criteria each test covers, and any fixtures or test-DB setup required.

## Rollout & Migration
Migration order, backfill, feature flags, deploy sequencing. `None` if not applicable.

## Security Considerations
Which Security Review triggers apply (auth, new external endpoint, data-access control, API-key logic), or "no security-relevant changes."

## Open Items
- [ ] Known limitations or edge cases not addressed
- [ ] Follow-up work deferred for later
- [ ] Unresolved design questions

`None` only if genuinely zero — this is where `gather-open-items` looks.
```

### Step 5: Update companion docs in the same change

- If **Data Model & Schema Changes** is non-empty, update `docs/design/data-model.md`.
- If **Proposed Design** moves module layout, layer boundaries, or a cross-cutting pattern, update `docs/design/architecture.md`.
- If **Alternatives Considered** settled an architectural decision, create the ADR now (`docs/decisions/${NNN}_name.md`, format in `CLAUDE.process.md`).

### Step 6: Approval (hard stop — always)

Design-doc approval is a hard stop regardless of the Autonomy Policy.

- Present the doc path and walk the user through Proposed Design, Data Model & Schema Changes, and Alternatives Considered.
- Ask directly: approved, or revise? Record follow-up answers inline in the doc.
- On approval: set frontmatter `status: APPROVED`, set the feat-req `status: DESIGNED`, run `scripts/render-status.mjs`, and tell the user the next phase is `/write-execution-plan <name>`.

### Constraints

- One design doc per feature request, filename-matched. Do not fold multiple feat-reqs into one.
- Every Step 4 heading must be present. Use `None`, not deletion, for empty sections.
- Do not write the execution plan here. Stop after Step 6.
