# `yaml` as the meta-root's one script dependency

## Status
Accepted

## Context
`repos.yml` is nested (a map of repo entries, each with lists and multi-paragraph strings). `render-status.mjs` parses only flat `key: value` frontmatter by hand; that technique does not extend to the catalog. The scripts had been specified as strictly zero-dependency.

## Options Considered
- **`repos.json`** — `JSON.parse` is built-in, truly zero-dep. But the catalog is human-edited and its `summary` fields are paragraphs; JSON has no multi-line strings and adds quote/comma noise exactly where humans type most.
- **Hand-rolled restricted YAML parser** — keeps zero-dep and YAML ergonomics, but is ~60–100 lines to write, test, and maintain, and breaks on valid YAML it wasn't built for.
- **Add `yaml`** (npm, by eemeli) — the de-facto standard YAML parser for Node, actively maintained, no transitive dependencies.

## Decision
Add `yaml` as the meta-root's single dependency. The meta-root gets a `package.json`; `setup-sdlc` runs `npm install`. `render-status.mjs` keeps its hand-rolled frontmatter parser (flat, and it works) — `yaml` is only for `repos.yml`.

## Consequences
- The "zero-dependency scripts" claim becomes "one dependency." Adopters need `node` + `npm` (they almost certainly already have both).
- `package.json` + `node_modules/` now exist at the meta-root; `node_modules/` joins `.gitignore`, `package-lock.json` is committed.
- Future scripts may use `yaml` freely; adding a *second* dependency should get its own ADR.
- Pin the version in `package.json`.
