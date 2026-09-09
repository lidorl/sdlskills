---
name: write-history-entry
description: Use after executing a plan (or after any trivial/hotfix change) to record an execution trace in docs/history/ — the intent-vs-reality record that git diffs and the plan's checkboxes cannot reconstruct.
---

The history entry is the agent-readable trace of what actually happened during implementation. Git captures the diffs; the plan captures the intended steps; this file captures **where reality diverged from intent** and what was learned. Write it while the work is fresh.

### File

`docs/history/${timestamp}_<short-description>.md` where `${timestamp}` is `YYYYMMDD-HHMMSS`. One file per plan execution (or per trivial/hotfix change).

### Standard tier

```markdown
---
date: YYYY-MM-DD
tier: standard
feat_req: docs/feat-req/<name>.md
plan: docs/plans/<name>.md
repos: [<key>, <key>]
---

# <Description>

## Per-Repo Summary
| key | tier | branch | PR | what changed |
|---|---|---|---|---|

Single-repo effort: one row. The narrative sections below stay single across all repos.

## Deviations
Where execution diverged from the plan and why. "Plan said X, reality needed Y because Z." `None` if the plan was followed exactly.

## Discoveries
Things learned during implementation that weren't in the design or plan — a hidden coupling, a broken assumption, a test that revealed a gap.

## Decisions
Choices made during implementation that didn't rise to an ADR. What and why.

## Step Status
Each plan step: done / partial / deferred-to-open-items. For partial or deferred, one line on what remains.

## Verification
Which tests were run and their outcome (paste the summary line). Which Acceptance Criteria are now met. Any manual checks performed.

## Files Touched
Brief list for orientation — path plus one phrase. (The diffs are in git; don't restate them.)
```

### Trivial tier

One short entry:

```markdown
---
date: YYYY-MM-DD
tier: trivial
---

# <Description>

- **Change:** <the one-line justification from /classify-change>
- **Rule:** <the trivial-test condition or absence of carve-outs>
- **Files:** <list>
- **Tests:** <what was run / added, outcome>
```

### Hotfix tier

Standard-tier structure **plus** an `## Incident` section at the top:

```markdown
## Incident
- **What broke:** ...
- **Detected:** <when / how>
- **Root cause:** ...
- **Why this fix works:** ...
- **Blast radius:** <who/what was affected>
- **Follow-up feat-req:** docs/feat-req/<name>.md
```

### Constraints

- Record intent-vs-reality, not a diff summary. If the entry could be regenerated from `git log --stat`, it is missing the point.
- Write it before claiming the work complete — it feeds `/close-out`.
- `None` is a valid answer for Deviations / Discoveries / Decisions. Do not invent content to fill them.
