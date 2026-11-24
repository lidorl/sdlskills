---
date: 2026-11-24
priority: High
severity: High
status: ACCEPTED
source: Security review finding on scripts/lib/worker/agent.mjs (2026-11-24), and the "Copilot worker isolation" item from the PR #17 review
---

# Contain worker agent runs: phase allowlists, required sandbox, no bypass flags

> **Binding contracts.** These are requirements, and the acceptance criteria test against them: no worker passes a permission-bypass flag to its agent; every phase runs with an explicit tool allowlist; phases that run project code (implement, verify) run only inside an active OS-level sandbox unless the worker carries a recorded opt-out; and a worker refuses to start when the containment it is configured for isn't actually in effect. Design must honour them or amend them explicitly, with the reason recorded in the design doc. Only "Solution Direction" is non-binding.

## Problem & Context

Workers run an agent CLI unattended, on a machine that holds the owner's `gh` login and git credentials, against repos and documents that may contain hostile text. A confused or prompt-injected run can do anything the agent's permissions allow.

Today the two agents differ:
- **Claude workers** run with Claude Code's sandbox on: `sandbox.enabled`, shell auto-allowed only inside the sandbox, `permissions.defaultMode: acceptEdits` (`agentSettings()` in `scripts/lib/worker/home.mjs`).
- **Copilot workers** run with `--allow-all-tools` (`agentCommand()` in `scripts/lib/worker/agent.mjs`). Path verification stays on, but shell commands run with no sandbox, the owner's credentials and full network access. The README only advises a separate OS user or VM.
- **Both agents** append the worker's `cli_args` unfiltered. A config can add `--allow-all`, `--allow-all-paths` or `--dangerously-skip-permissions` and silently remove whatever containment exists.

A tool allowlist alone doesn't fix this. Implement and verify phases must run the project's own commands (tests, builds, package scripts), and those run arbitrary repo code. `shell(npm:*)` is allow-all in practice. Only an OS-level sandbox actually contains those phases.

An automated security review flagged the Copilot launch as HIGH severity (2026-11-24).

## Users & Personas

- **Operator**: runs workers on their own machine or a shared host, and needs a confused or injected run unable to damage the host, leak credentials, or push where it shouldn't.
- **Team lead**: wants to see on the board which workers run contained and which have opted out.
- **Copilot adopter**: wants Copilot workers to be usable without hand-building a VM.
- **Claude adopter**: keeps today's sandbox, and gains the guarantee that it is really on.

## Scenarios

- As an operator, I start a Copilot worker on a machine with a supported sandbox. Planning phases run with a narrow tool allowlist, and implement and verify run inside the sandbox.
- As an operator, I start a Copilot worker where no supported sandbox is available. It refuses to start and the message says what to install, or how to opt out and what that means.
- As an operator who accepts the risk (for example on a throwaway VM), I set `unsandboxed: true`. The worker starts, the opt-out is recorded in its registry entry, and the board shows it as unsandboxed.
- As a team lead, I see on the board which workers are sandboxed and which have opted out.
- As an operator, my Claude worker's machine lacks what Claude Code's sandbox needs. The worker refuses to start, instead of running with the sandbox silently off.
- **Unhappy:** a worker config has `--allow-all-tools`, `--allow-all`, `--allow-all-paths` or `--dangerously-skip-permissions` in `cli_args`. `sdlc worker create`, `config` and `start` reject it with a reason.
- **Unhappy:** an implement run tries to write outside its workspace, read the owner's credential files, or push to a remote. The sandbox blocks it, and the run reports an effort error.
- **Unhappy:** a planning-phase run tries a tool outside its allowlist. The CLI denies it and the run continues or fails cleanly.
- **Unhappy:** an existing Copilot worker created before this change is started. It refuses until a sandbox is set up or it is opted out, with a message naming this change.

## In Scope

- **Rejecting bypass flags** in `cli_args`, for both agents, at `create`, `config` and `start`. A maintained deny list includes `--allow-all`, `--allow-all-tools`, `--allow-all-paths`, `--allow-all-urls` and `--dangerously-skip-permissions`.
- **Per-phase tool allowlists for both agents.**
  - Planning phases (feature request, design, plan, close-out documents): read, write within the meta clone and workspace, and `git` and `sdlc` commands the phase needs.
  - Implement and verify: the allowlist plus the sandbox.
  - For Copilot this replaces `--allow-all-tools` with `--allow-tool` / `--deny-tool` / `--available-tools`. For Claude it is expressed in the settings file the worker writes.
- **A required OS-level sandbox for implement and verify:**
  - filesystem writes confined to the worker's workspace and meta clone;
  - no access to the owner's credential stores;
  - network egress limited to what the phase needs.

  This is required for Copilot workers and verified for Claude workers.
- **Credential separation** (my call). Where a phase doesn't need credentials, the sandboxed agent gets none. Pushes to code repos and board writes stay with the worker loop, outside the sandbox, as `code-repos.mjs` and `boardWrite` already do.
- **A start-up check.** A worker confirms its containment is actually in effect (sandbox available and enabled, allowlist applied) and refuses to start otherwise.
- **An explicit opt-out**, `unsandboxed: true` in the worker config (my call on the name). It is mirrored to the registry, shown in `sdlc worker status`, `list` and on the board, and recorded in each run's commit trailers.
- **Migration:** existing Copilot workers refuse to start until configured, with a clear message.
- **Docs:** the README's Copilot advice is replaced by the supported setup. The open item on Copilot worker isolation is closed by this request.

## Out of Scope

- Containing interactive sessions. A person at the keyboard approves actions there.
- Copilot's cloud agent, which is already out of scope for the kit.
- A hosted runner or remote execution service.
- Access control over who may create workers.
- Defending against a malicious worker owner. The threat is a confused or injected agent, not the operator.

## Acceptance Criteria

- [ ] No code path passes `--allow-all-tools` or any other listed bypass flag to an agent CLI (tested on the generated arguments for every agent and phase).
- [ ] `cli_args` containing a listed bypass flag is rejected by `create`, `config` and `start`, with a reason.
- [ ] Every phase launches its agent with an explicit tool allowlist, and the allowlist for each phase is covered by a test.
- [ ] A Copilot worker without an available supported sandbox and without `unsandboxed: true` refuses to start, and the message names the fix.
- [ ] A Claude worker whose sandbox isn't available refuses to start instead of running unsandboxed.
- [ ] Inside the sandbox, an implement run can't write outside its workspace and meta clone, can't read the owner's credential files, and can't reach a host outside the allowed list (tested with a fixture agent that tries each).
- [ ] The sandboxed agent's environment contains no git or `gh` credentials in phases that don't need them.
- [ ] A worker with `unsandboxed: true` shows as unsandboxed in `sdlc worker status`, `list`, the registry and the board, and its run commits carry that in a trailer.
- [ ] An existing Copilot worker created before this change refuses to start until configured, with a message naming this change.

## Success Metrics

- No worker on any board runs implement or verify uncontained without a recorded opt-out, checked by a board report.
- No security-review finding of this class (agent permission bypass) remains open against `scripts/lib/worker/`.

## Constraints & Dependencies

- **Dependencies:** workers (`docs/feat-req/workers.md`, merged). Roles from the independent verification request will add a verify phase, which must get the sandbox too.
- **Constraints:**
  - The sandbox must work on macOS and Linux at least. Windows support is decided in design.
  - It can't require tools most adopters don't have without an install path. A container route (Docker or Podman) is likely the portable option, with platform sandboxes where available.
  - Network allowlists must leave room for the model API, GitHub and the project's package registries, so they need to be configurable per repo.
  - Copilot's flag names and Claude Code's sandbox settings can change between CLI versions. The start-up check catches drift.

## Open Questions

- Which sandbox mechanisms are supported: a kit-provided container image, macOS `sandbox-exec`, Linux bubblewrap, or Claude Code's own sandbox reused for Copilot?
- Can Copilot run inside Claude Code's sandbox runtime, or does it need its own?
- What's the default network allowlist, and where is it configured (worker config, `board/config.yml`, per repo in `repos.yml`)?
- Does any planning or close-out phase need credentials inside the agent (for example opening a PR with `gh`)? If so, should that move to the worker loop?
- Exact per-phase allowlists for each agent.
- Should the opt-out expire or need renewal?

## Solution Direction

Non-binding. Keep one table that maps each phase to its tools and sandbox requirement, and generate both agents' arguments and settings from it, so the two can't drift. Treat the start-up check like the existing preflight in `scripts/lib/worker/preflight.mjs`.
