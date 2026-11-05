---
name: code-review
description: Use at the Code Review phase, or when the Definition of Done calls for `/code-review` — reviews the change for correctness, plan conformance, and project conventions, then reports ranked findings.
---

Copilot in VS Code has no built-in `/code-review`, so this skill defines it on every surface.

### Step 1: Scope

Take the diff from the merge-base with the default branch, plus uncommitted changes. For multi-repo work, do this in `workspace/<key>/` for every repo in the plan's `## Repositories`. Done when every changed file is listed.

### Step 2: Review

Read each changed hunk with enough surrounding code to judge it, and check it for:

- Correctness: bugs, unhandled failure paths, broken callers.
- Tests: changed behavior is covered by a test that would fail without the change.
- Spec: the change matches the design doc and plan, with nothing missing or added.
- Conventions: the rules in `CLAUDE.stack.md`.
- UI: conformance to `docs/design/STYLE_GUIDE.md`, when the file exists and the diff touches UI or user-facing output.

Done when every changed file has been checked against every applicable item.

### Step 3: Report (hard stop)

List findings most severe first, each with `file:line`, the defect, and the concrete scenario that triggers it. State "no findings" when there are none. Findings are a hard stop under the Autonomy Policy: wait for the user's decision on each one.
