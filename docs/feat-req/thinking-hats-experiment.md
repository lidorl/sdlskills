---
date: 2026-11-23
priority: Medium
severity: Low
status: PARKED
source: Extracted from 04-thinking-hats-definition-and-design.md (2026-11-23 software-factory discussion), narrowed to an experiment with a go/no-go decision
---

# Six Thinking Hats experiment for the design phase

> **Binding contracts.** These are requirements, and the acceptance criteria test against them: this effort is an experiment that ends in a recorded go/no-go decision; each hat runs in its own context, limited to the inputs its definition lists; all five setups run on the same seeded test material; and the brief is scored separately from the raw hat outputs. Design must honour them or amend them explicitly, with the reason recorded in the design doc. Only "Solution Direction" is non-binding.

## Problem & Context

Most of the thinking in the lifecycle happens in definition and design, and one agent does it in one blended pass. Facts, risks, benefits and alternatives get mixed together, so the human approval gates receive a long document written from a single point of view.

The proposal in `04-thinking-hats-definition-and-design.md` is to run De Bono's Six Thinking Hats as separate roles, each in its own context, with a Blue orchestrator that writes a short decision brief for the gate. Building that in full means:
- an orchestrating skill and hat definition files;
- calls from `write-feature-request` and `write-design-doc`;
- a policy setting;
- a headless executor that depends on worker roles (`docs/feat-req/independent-verification.md`).

The evidence for it is weak. Research on multi-agent debate points to model diversity, not persona prompts, as the main driver of better results. No direct study of Six Hats on software decisions was found. The cheap baseline, one agent asked for the same six sections in a single prompt, may do just as well. And hats multiply cost by the number of hats.

So this request is to **find out whether hats earn their cost before building them**. The full feature, including the definition phase, policy, Copilot and headless execution, is a follow-up request filed only on a "go".

## Users & Personas

- **Kit maintainer**: decides whether to invest in hats, and wants a measured answer, not an impression.
- **Approver** (indirectly): the person whose gate the brief would serve. Their time and override rate are measured only after a "go", because a replay can't measure them.

## Scenarios

- As the kit maintainer, I run the evaluation on the kit's own design docs with seeded flaws. I get a report comparing five setups on flaws caught, noise and cost, and a go/no-go decision against thresholds set before the run.
- As the kit maintainer, I look at a hat run's raw outputs next to the Blue brief to see what the brief dropped.
- **Unhappy:** the single different-model critic catches as many seeded flaws as the full hats. That is a "no-go" for hats, and the follow-up instead considers adding the critic, for example as a role from the verification request.
- **Unhappy:** results vary so much between runs that no setup clearly wins. The report says so, and the decision is "no-go" or "rerun with more test material", never a "go" by default.
- **Unhappy:** Blue's brief leaves out a seeded flaw that a hat found. The raw-versus-brief scoring shows it.
- **Unhappy:** every hat on one model shares the same blind spot. The single-model and different-model setups show the difference.

## In Scope

- **Design phase only.** The definition phase waits for a "go".
- **Hat definition files** for White, Green, Yellow, Black and Blue, in the format sketched in file 04: role, `reads`, `must_not_read`, `model_hint`, `max_items`, instructions and output format. Red is excluded from the experiment.
- **A minimal runner** that executes the hats as Claude Code sub-agents. Each hat gets only the inputs its definition lists. Black can be assigned a different model from the author.
- **The Blue brief format**: a one-page synthesis, with each hat's output shown beside it.
- **Test material.** The kit's own design docs (execution-environment, workers, guided install) with flaws planted by hand: missing failure modes, conflicts with existing contracts, scope gaps. An answer key lists the planted flaws for each doc.
- **Five setups**, each run several times per design doc:
  1. a single agent with no extra prompt;
  2. a single agent with the six-section prompt;
  3. hats, all on one model;
  4. hats, with Black on a different model;
  5. the six-section prompt plus one Black critic on a different model.
- **Measures:**
  - seeded flaws caught, scored on the raw outputs and, separately, on the brief;
  - noise: findings that are wrong or irrelevant;
  - cost in tokens and wall time;
  - variance between runs.
- **A report** under `docs/` with the numbers, the method and the go/no-go decision, recorded so it isn't argued again.

## Out of Scope

- The definition phase (`write-feature-request`) and its flow (White before the interview, critique after the draft, brief at triage).
- Calls from `write-design-doc`, and changes to its Alternatives Considered step.
- The `hats: off | brief | full` policy setting and defaults by tier.
- Headless execution through worker roles, and Copilot support.
- The Red hat.
- Measuring human gate time and override rate, which can't be done on replays.
- Building the full feature. On a "go", that is a separate feature request.

## Acceptance Criteria

- [ ] Hat definition files exist for White, Green, Yellow, Black and Blue, each listing what it reads and what it must not read.
- [ ] Each hat's context contains only the inputs its definition lists (tested on what the runner passes to it).
- [ ] Black can run on a different model from the author, and the run records which model each hat used.
- [ ] At least three design docs are seeded, each with an answer key of planted flaws, written before any setup is run.
- [ ] All five setups run on the same test material, with several runs each, and the raw outputs are kept.
- [ ] Flaws caught are scored on both the raw hat outputs and the Blue brief.
- [ ] The report gives flaws caught, noise, tokens, wall time and run-to-run variance for each setup.
- [ ] The report ends with a go/no-go decision against the thresholds below, and the decision is recorded in this feature request's `## Triage` or a linked decision record.

## Success Metrics

The experiment succeeds when it produces a clear decision, whichever way it goes. The **go thresholds** are provisional and are to be confirmed before the first run:

- Full hats (setup 4) catch **at least 25% more seeded flaws** than the six-section prompt (setup 2).
- At **no more than 3× the cost** in tokens.
- They **clearly beat the single different-model critic** (setup 5): the margin exceeds the run-to-run variance.
- The Blue brief keeps at least as many caught flaws as the raw outputs of the six-section prompt contain.

If the critic setup meets the first two thresholds and hats don't beat it, the decision is "no-go for hats". The report then recommends the critic as the cheaper alternative.

## Constraints & Dependencies

- **Dependencies:** none blocking. The runner uses Claude Code sub-agents, so it needs neither the workers board nor roles from the verification request.
- **Constraints:**
  - "Different model" means a different Claude model in this experiment. A comparison across vendors is left for the follow-up.
  - The test material is small (three real design docs), so variance must be measured and reported, not assumed away.
  - The answer keys must be written before any run, so the scoring can't be fitted to the results.
  - Cost multiplies by the number of hats. Run independent hats in parallel (Yellow with Black) to keep wall time down.

## Open Questions

- Confirm the go thresholds before the first run: 25% more flaws, 3× cost, and how "clearly beats" is computed.
- Who plants the flaws and writes the answer keys, and should a second person check the keys for leaks into the docs?
- How many runs per setup are enough, given three design docs?
- Does Blue's synthesis need a different model from the hats, to avoid favouring the most fluent argument? It could be added as a sixth setup if it's cheap.
- How is a finding matched to a planted flaw: by hand, or with a rubric plus spot checks?

## Solution Direction

Non-binding. Keep the hat definitions in a folder the later skill can adopt unchanged (for example `skills/thinking-hats/hats/<hat>.md`), so a "go" reuses them as they are. The runner can be a thin script or a skill that launches one sub-agent per hat with an explicit file list, writes raw outputs to a run-log folder outside `docs/`, and passes only the listed outputs to Blue.

## Triage

**PARKED** (2026-11-23).

- **Reason:** valid, but not now. The open factory gaps come first: independent verification, the board-write coordinator and feature breakdown. Hats improve the quality of thinking before a gate, the evidence for them is weak, and the experiment costs real effort and tokens.
- **Un-park when:** independent verification and the board-write coordinator are `IMPLEMENTED`, or when approvers report that design and triage gates are the bottleneck (long, single-viewpoint documents) before then.
