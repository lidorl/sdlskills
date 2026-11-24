---
name: write-feature-request
description: Use to intake a new feature — runs a product interview to sharpen the idea into a clear spec, writes it to docs/feat-req/, and ends with a triage decision (accept / park / reject). The first phase of the SDLC lifecycle.
---

A feature request is a **product spec**: what to build, for whom, and why — not how. The interview is the real work; writing the file is serialization.

Given the slug of a feat-req that already exists, skip to **Re-check mode** below.

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

### Step 1.5: Size check

Always run this, after the interview and before writing anything. Read the thresholds from **Breakdown** in `CLAUDE.process.md`.

Count or estimate five signals from the interview:

| Signal | How |
|---|---|
| `criteria` | number of acceptance criteria drafted |
| `personas` | number of distinct personas |
| `repos` | number of repos the request touches (from `repos.yml`) |
| `files` | rough estimate of files changed |
| `independent_parts` | the parts of the request that would each deliver value on their own, named |

**Rule:** propose a split when at least one size signal exceeds its threshold **and** there are at least two independent parts. Without independent parts there is nothing to slice vertically: the request stays whole even if it is big, and plan breakdown handles the size later.

**Minimum slice:** each proposed slice needs at least `min_slice_criteria` acceptance criteria. Merge a smaller slice into a neighbour before proposing. If that leaves fewer than two slices, there is no split.

**Always record the result** in the spec's `## Sizing` section, as one dated line:

```markdown
## Sizing
- YYYY-MM-DD: <n> criteria, <n> personas, <n> repo(s), ~<n> files; independent parts: <names or none> → <no split | split into a, b, c | split proposed, declined: <reason>>
```

For a confirmed split, each slice's line names the split (`split into a, b, c`).

**Proposing slices.** When the rule fires, propose 2–5 slices. Prefer, in order:

1. vertical slices that each deliver user value;
2. a thin first slice that proves the path end to end;
3. slices by repo or layer, only when there is no other way.

For each proposed slice, show:

- its slug;
- a one-line goal;
- its acceptance criteria count, and its scenarios and criteria, taken from the interview (invent nothing);
- its `after` list: the slices it needs first, if any.

State which criteria went to which slice, so nothing is dropped or duplicated. Write nothing yet: the split is decided in Step 3.

### Step 2: Write the spec

Write only after the split decision in Step 3 is settled. With no split, or a declined one, write one spec. For a confirmed split, write one file per slice and no file for the original idea.

Before writing each file, confirm its slug is free: no existing `docs/feat-req/<slug>.md`. If it is taken, pick another slug and say so.

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

## Sizing
- [YYYY-MM-DD: the Step 1.5 result line.]

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

**Split first.** When Step 1.5 proposed a split, settle it before Step 2 writes any file. Present the proposed slices and ask the user to:

- **accept** the split;
- **edit** it (merge slices, move criteria, rename, reorder `after`), then accept;
- **decline** it: write one spec as usual, and record `split proposed, declined: <reason>` in its `## Sizing` line.

Then, per spec (or per slice), present the path and a one-paragraph summary. Ask the user to choose:

- **ACCEPTED** — enters the queue. Leave `status: ACCEPTED`.
- **PARKED** — valid but not now. Set `status: PARKED` and add a `## Triage` section with the reason and any condition for un-parking.
- **REJECTED** — not doing it. Set `status: REJECTED` and add a `## Triage` section with the reason. Keep the file.

Record the decision in the `## Triage` section for PARKED/REJECTED so it is not re-litigated.

Decide each slice on its own: parking one slice doesn't park the others.

**Slice records.** Each slice is an ordinary feat-req with two extra frontmatter fields:

```yaml
split_from: <original-slug>   # the original idea's slug; a label, never a file
after: [<slug>, …]            # slugs that must be IMPLEMENTED first; omit when empty
```

`split_from` must not name an existing feat-req file. At intake it is the slug the idea would have had; check `docs/feat-req/` and pick another if it is taken.

Every slice gets a `## Triage` section, whatever its decision:

```markdown
## Triage
**<ACCEPTED | PARKED | REJECTED>** (YYYY-MM-DD). Split from `<original-slug>` on YYYY-MM-DD.
- **Reason for the split:** <why>
- **Slices:** `<slug-a>`, `<slug-b>` (after `<slug-a>`), …
- **Original text:** split at intake.
```

At intake the original was never written, so "Original text" says `split at intake`; carry the shared "why" in each slice's Problem & Context. In re-check mode, it cites the commit instead (see **Re-check mode**).

### Step 4: Hand off

- Run `scripts/render-status.mjs` (or note the `Stop` hook will).
- If ACCEPTED, tell the user the next phase is Design (`/write-design-doc <name>`), or that `/select-next-task` will pick it up.
- Board mode, interactive: the effort reaches workers only once it is on `main`. Tell the user to commit and push the new feat-req.
- Headless (`SDLC_HEADLESS=1`): the triage in Step 3 becomes a `triage` gate; see **Headless mode** in `CLAUDE.process.md`. Still run Step 1.5 and record `## Sizing`, but never split headless: write one spec, and when the check proposes a split, put the proposed slices in the ordinary `triage` gate's Context section. The person can accept the request whole, park or reject it, or split it later with **Re-check mode**.

### Re-check mode

`/write-feature-request <slug>` where `docs/feat-req/<slug>.md` already exists re-checks that spec's size. It runs only when asked this way; no other skill triggers it.

1. Load the spec and skip the interview.
2. **Preconditions.** Stop and tell the user if any fails:
   - the feat-req is `status: ACCEPTED` (nothing downstream refers to it yet);
   - board mode: after `git pull`, read the feat-req's `awaiting`. If it is set and `board/requests/<awaiting>.md` exists with `status: open`, stop. Use `node scripts/sdlc.mjs status --json` `inFlight` only for the claim: stop when the entry's `claimant` isn't you and `stale` is false. Your own claim and a stale foreign claim don't block a re-check;
   - `git log -1 --format=%h -- docs/feat-req/<slug>.md` prints a commit. If it prints nothing, the original was never committed: stop and ask the person to commit the spec first.
3. Run Step 1.5 on what the spec says, then propose and triage exactly as in Step 3. On a decline or no split, don't rewrite the spec or re-triage it; go to step 5.
4. **Confirmed split:** write the slices, and `git rm docs/feat-req/<slug>.md` in the same change. Before removing it, take the commit from the precondition above. Each slice's Triage cites it: `- **Original text:** commit <sha>, docs/feat-req/<slug>.md.` Set `split_from: <slug>`; the name is free once the file is removed. If the original itself has `split_from`, the new slices keep that value instead, so they stay in the same Splits group. Then search `docs/feat-req/` for `after` entries naming `<slug>`. In the same change, replace each with the slice(s) that deliver what that effort needs (default: all of them), and list these edits at the split decision.
5. **No split** (or declined): append one line to `## Sizing`, and change nothing else. If the spec has no `## Sizing` section (written before this check existed), add it after `## Success Metrics` first, then append the line:

   ```markdown
   - YYYY-MM-DD: re-checked: <n> criteria, <n> personas, <n> repo(s), ~<n> files; independent parts: <names or none> → <no split | split proposed, declined: <reason>>
   ```

### Constraints

- One feature request per file. A large request is split at intake when the size check says so (Step 1.5); plan breakdown handles size found later.
- Do not design in this skill. "Solution Direction" is a hint, not a design.
- Do not skip the interview because the request "seems clear" — the unhappy paths and scope boundary are where clarity is usually missing.
