# Kit Open Items

Unresolved design questions about the SDLC kit itself (not about any project that adopts it). Each is a specific deferred decision from work already done. Larger, less-formed directions live in [`../BRAINSTORMING.md`](../BRAINSTORMING.md).

## Open Items

- [ ] **Parallel agents / task claiming.** The current process (`select-next-task`, unified queue, `status: IN_PROGRESS`) assumes a single worker. Supporting 2+ agents needs: task claiming vs. locking, stale-claim recovery, worktree/branch isolation, merge/review ordering, and how `render-status.mjs` reflects concurrent work. Decided for now: **single worker**. (The broader multi-repo *execution environment* idea is [`BRAINSTORMING.md`](../BRAINSTORMING.md) §1 — related but a separate axis.)

- [ ] **`writing-plans` frontmatter contract.** `write-execution-plan` stamps `status`/`feat_req`/`design` onto the plan file *after* `superpowers:writing-plans` runs. If the upstream skill's output format changes, the stamp step may need updating. Watch for drift on `superpowers` upgrades.

- [ ] **Trivial-tier history entries and `render-status.mjs`.** Trivial changes produce a `docs/history/` entry but no feat-req, so they never appear in `docs/STATUS.md`. Fine for now (STATUS.md tracks features, not every commit), but if trivial-change volume matters, consider a rollup.

- [ ] **Workspace path drift for out-of-repo tooling.** `workspace/<key>/` is a normal checkout, so in-repo build / Docker / test scripts work unchanged. The gap is tooling that hard-codes a checkout path *outside* the repo — a CI runner config, an IDE workspace file, a sibling-repo relative import. Decided for now: document the `workspace/<key>/` convention and let adopters symlink a stable path if their tooling needs one. Revisit if it bites in practice. (From the 2026-09-09 external architectural review.)

- [ ] **Multi-repo partial-merge recovery.** The plan sets merge order and `close-out` verifies a merged PR per repo, but nothing defines the procedure when an early repo's PR merges and a later one then fails review or needs rework — the system sits briefly in a partial state. Options: require every PR approved before any merges; a documented rollback/hold procedure; feature-flag the cross-repo seam. Decided for now: merge order + "all PRs open and approved before the first merge" as guidance; formal atomicity deferred. (From the 2026-09-09 external architectural review. Related: execution-environment Open Questions.)
