#!/usr/bin/env node
/**
 * assemble-env.mjs — reconstruct workspace/ for an effort. Idempotent.
 * See docs/design/execution-environment.md → "Scripts".
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadCatalog } from './lib/catalog.mjs';

// URL-scheme safety (refuse anything but https:// and git@) is enforced in
// catalog.mjs → validateCatalog, which loadCatalog runs. Callers that pass an
// explicit `catalog` object have taken responsibility for its contents.
const git = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

export function resolveRepoKeys(rootDir, slug, extraKeys = []) {
  const keys = new Set(extraKeys);
  const design = join(rootDir, 'docs', 'design', `${slug}.md`);
  if (existsSync(design)) {
    const fm = readFileSync(design, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const line = fm && fm[1].match(/^repos:\s*\[(.*)\]\s*$/m);
    if (line) line[1].split(',').map((s) => s.trim()).filter(Boolean).forEach((k) => keys.add(k));
  }
  return [...keys];
}

function tryGit(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  } catch {
    return null;
  }
}

/**
 * Put `dest` on the effort branch, choosing the base explicitly:
 *   1. local `feat/<slug>` already exists → check it out
 *   2. remote has `origin/feat/<slug>` (a prior session pushed it) → branch from there
 *   3. otherwise → branch from `origin/<default_branch>`
 * Never `git checkout -b` with an implicit start point (that would cut the new
 * effort's branch from whatever the previous effort left checked out).
 */
function checkoutEffortBranch(dest, branch, defaultBranch) {
  if (tryGit(dest, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]) !== null) {
    git(dest, ['checkout', branch]);
    return;
  }
  const remoteEffort = tryGit(dest, ['ls-remote', '--heads', 'origin', branch]);
  if (remoteEffort) {
    git(dest, ['fetch', 'origin', branch]);
    git(dest, ['checkout', '-b', branch, 'FETCH_HEAD']);
    return;
  }
  git(dest, ['fetch', 'origin', defaultBranch]);
  git(dest, ['checkout', '-b', branch, 'FETCH_HEAD']);
}

export function assemble({ rootDir, slug, keys, catalog }) {
  const cat = catalog ?? loadCatalog(rootDir);
  const branch = `feat/${slug}`;
  const wsDir = join(rootDir, 'workspace');
  mkdirSync(wsDir, { recursive: true });

  const warnings = [];
  const markerPath = join(wsDir, '.current-effort');
  if (existsSync(markerPath)) {
    const current = readFileSync(markerPath, 'utf8').trim();
    if (current && current !== slug) {
      const others = readdirSync(wsDir).filter((d) => !d.startsWith('.'));
      warnings.push(
        `workspace/ was assembled for "${current}" (${others.join(', ')}); reassembling for "${slug}". ` +
          `Stale checkouts left in place — run clean-env.mjs to remove.`
      );
    }
  }

  const cloned = [];
  const fetched = [];
  for (const key of keys) {
    const entry = cat.repos[key];
    if (!entry) throw new Error(`repos.yml has no entry for "${key}"`);
    const dest = join(wsDir, key);
    if (!existsSync(join(dest, '.git'))) {
      execFileSync('git', ['clone', '--depth', '1', entry.url, dest], { stdio: ['ignore', 'pipe', 'pipe'] });
      cloned.push(key);
    } else {
      git(dest, ['fetch', 'origin']);
      fetched.push(key);
    }
    checkoutEffortBranch(dest, branch, entry.default_branch);
  }

  writeFileSync(markerPath, `${slug}\n`);
  return { cloned, fetched, branch, warnings };
}

function main() {
  const args = process.argv.slice(2);
  const rootIx = args.indexOf('--root');
  const rootDir = rootIx !== -1 ? args[rootIx + 1] : process.cwd();
  const positional = args.filter((a, i) => a !== '--root' && args[i - 1] !== '--root');
  const [slug, ...extra] = positional;
  if (!slug) {
    console.error('usage: assemble-env.mjs <effort-slug> [<extra-repo-key> ...] [--root <dir>]');
    process.exit(2);
  }
  const keys = resolveRepoKeys(rootDir, slug, extra);
  if (!keys.length) {
    console.error(`no repos for "${slug}" — no docs/design/${slug}.md repos: list and no keys given`);
    process.exit(2);
  }
  const r = assemble({ rootDir, slug, keys });
  r.warnings.forEach((w) => console.warn(`warning: ${w}`));
  console.log(
    `assemble-env: ${slug} on ${r.branch} — cloned [${r.cloned.join(', ')}] fetched [${r.fetched.join(', ')}]`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
