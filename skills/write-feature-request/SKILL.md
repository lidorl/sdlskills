---
name: write-feature-request
description: Use to intake a new feature — runs a product interview to sharpen the idea into a clear spec, writes it to docs/feat-req/, and ends with a triage decision (accept / park / reject). The first phase of the SDLC lifecycle.
---

A feature request is a **product spec**: what to build, for whom, and why — not how. The interview is the real work; writing the file is serialization.

### Step 1: Product interview

Sharpen the idea with the user before writing anything. Check the Autonomy Policy in `CLAUDE.process.md`:

- `product_brainstorm: discuss` → run `superpowers:brainstorming` for the exploration, then continue here.
- `product_brainstorm: solo` → work the questions below yourself, record assumptions, and proceed. The triage in Step 3 is still a hard stop.

Drive answers to each of these. Loop until every one is concrete — a vague answer is not a settled answer:

- **Problem & context** — the current limitation or pain, and who feels it. What happens today without this?
- **Users & personas** — who uses this feature, in what role.
- **Scenarios** — concrete user stories ("as a X, I …"), including the unhappy paths.
- **In scope / out of scope** — draw the boundary explicitly. Name things a reader might assume are included but aren't.
- **Acceptance criteria** — specific, testable conditions.
- **Success metrics** — how you'll know it worked after shipping.
- **Constraints & dependencies** — blocking work, required infrastructure, deadlines, regulatory limits.
- **Open questions** — anything unresolved that design must answer.

### Step 2: Write the spec

`docs/feat-req/<kebab-name>.md`:

```markdown
---
date: YYYY-MM-DD
priority: [High/Medium/Low]
severity: [Critical/High/Medium/Low]
status: ACCEPTED
source: [User request / Extracted from <doc> / Hotfix follow-up for <incident>]
---

# [Clear, actionable title]

## Problem & Context
[The limitation, who feels it, what happens today without this.]

## Users & Personas
[Who uses this, in what role.]

## Scenarios
- As a [persona], I [action] so that [outcome].
- [Include unhappy paths.]

## In Scope
- [...]

## Out of Scope
- [...]

## Acceptance Criteria
- [ ] [Specific, testable condition]

## Success Metrics
- [How success is measured post-ship.]

## Constraints & Dependencies
- **Dependencies:** [blocking tasks, infra]
- **Constraints:** [deadlines, regulatory, technical]

## Open Questions
- [Unresolved — design must answer these.]

## Solution Direction
[Optional, non-binding. A hint at approach if the user has one. Design is not bound by it.]
```

Default `priority: Medium`, `severity: Low` if not established in the interview.

### Step 3: Triage (hard stop — always)

Present the spec path and a one-paragraph summary. Ask the user to choose:

- **ACCEPTED** — enters the queue. Leave `status: ACCEPTED`.
- **PARKED** — valid but not now. Set `status: PARKED` and add a `## Triage` section with the reason and any condition for un-parking.
- **REJECTED** — not doing it. Set `status: REJECTED` and add a `## Triage` section with the reason. Keep the file.

Record the decision in the `## Triage` section for PARKED/REJECTED so it is not re-litigated.

### Step 4: Hand off

- Run `scripts/render-status.mjs` (or note the `Stop` hook will).
- If ACCEPTED, tell the user the next phase is Design (`/write-design-doc <name>`), or that `/select-next-task` will pick it up.

### Constraints

- One feature request per file. A large feature that needs multiple design docs / plans is still one spec here — the plan phase splits the work.
- Do not design in this skill. "Solution Direction" is a hint, not a design.
- Do not skip the interview because the request "seems clear" — the unhappy paths and scope boundary are where clarity is usually missing.
