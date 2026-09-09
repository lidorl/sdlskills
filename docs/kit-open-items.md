# Kit Open Items

Unresolved design questions about the SDLC kit itself (not about any project that adopts it). Each is a specific deferred decision from work already done. Larger, less-formed directions live in [`../BRAINSTORMING.md`](../BRAINSTORMING.md).

## Open Items

- [ ] **Parallel agents / task claiming.** The current process (`select-next-task`, unified queue, `status: IN_PROGRESS`) assumes a single worker. Supporting 2+ agents needs: task claiming vs. locking, stale-claim recovery, worktree/branch isolation, merge/review ordering, and how `render-status.mjs` reflects concurrent work. Decided for now: **single worker**. (The broader multi-repo *execution environment* idea is [`BRAINSTORMING.md`](../BRAINSTORMING.md) §1 — related but a separate axis.)

- [ ] **`writing-plans` frontmatter contract.** `write-execution-plan` stamps `status`/`feat_req`/`design` onto the plan file *after* `superpowers:writing-plans` runs. If the upstream skill's output format changes, the stamp step may need updating. Watch for drift on `superpowers` upgrades.

- [ ] **Trivial-tier history entries and `render-status.mjs`.** Trivial changes produce a `docs/history/` entry but no feat-req, so they never appear in `docs/STATUS.md`. Fine for now (STATUS.md tracks features, not every commit), but if trivial-change volume matters, consider a rollup.
