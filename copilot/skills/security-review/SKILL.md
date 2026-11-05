---
name: security-review
description: Use when a Security Review trigger applies, or when the Definition of Done or a hotfix calls for `/security-review` — reviews the change for exploitable vulnerabilities and reports them with remediations.
---

Copilot in VS Code has no built-in `/security-review`, so this skill defines it there. In Copilot CLI the built-in command of the same name is equally valid.

### Step 1: Scope

Take the diff from the merge-base with the default branch, plus uncommitted changes. For multi-repo work, do this in `workspace/<key>/` for every repo in the plan's `## Repositories`. Read the Security Review triggers in `CLAUDE.stack.md`. Done when every changed file is listed.

### Step 2: Review

Trace untrusted input through each changed path, and check for:

- Authentication and authorization: every new or changed entry point enforces both.
- Injection: SQL, command, template, path traversal, and XSS.
- Secrets: nothing hard-coded, logged, or returned.
- Data access: queries scoped to the caller, with no cross-tenant or excess exposure.
- Dependencies: new packages are justified and free of known advisories.

Done when every changed entry point has been traced.

### Step 3: Report (hard stop)

List findings by severity, each with `file:line`, the exploit scenario, and the remediation. Record them in the design doc, including a clean result. Findings are a hard stop under the Autonomy Policy: wait for the user's decision on each one.
