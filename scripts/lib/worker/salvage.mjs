// Ruling P2-11: the worker's clone and code checkouts are private, so leftover edits (a lost effort, a report
// that did not land, a stray) would block every later effort and no person could reach them. They move to
// <home>/salvage/<stamp>/ (same relative paths, each one logged) and the clone goes back to HEAD.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const stampOf = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');

// Dirty files of a repo: [{ path, inHead }]; `only` limits them to those paths. Directory entries (a nested
// repository shows up as `?? dir/`) and, in the meta clone, anything under workspace/ are never touched:
// the code checkouts are salvaged on their own, and deleting one would lose its unpushed commits.
function dirtyPaths(repo, only, { skipWorkspace = false } = {}) {
  const recs = git(repo, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all']).split('\0').filter(Boolean);
  const paths = recs.map((r) => r.slice(3))
    .filter((p) => !p.endsWith('/') && !(skipWorkspace && (p === 'workspace' || p.startsWith('workspace/'))))
    .filter((p) => !only || only.includes(p));
  return paths.map((path) => ({ path, inHead: git(repo, ['ls-tree', '--name-only', 'HEAD', '--', path]).trim() !== '' }));
}

// Copy each dirty file under `dest`, then put the repo back to HEAD for those paths.
function moveAside(repo, dirty, dest, log, label) {
  for (const { path } of dirty) {
    const src = join(repo, path);
    if (existsSync(src) && statSync(src).isFile()) {
      const to = join(dest, path);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(src, to);
      log(`salvaged ${label}${path} -> ${to}`);
    } else {
      log(`salvaged ${label}${path} (deleted locally; restored from HEAD)`);
    }
  }
  const tracked = dirty.filter((d) => d.inHead).map((d) => d.path);
  const untracked = dirty.filter((d) => !d.inHead).map((d) => d.path);
  if (tracked.length) git(repo, ['checkout', 'HEAD', '--', ...tracked]);
  if (untracked.length) {
    git(repo, ['rm', '-q', '-r', '--cached', '--ignore-unmatch', '--', ...untracked]);
    for (const p of untracked) rmSync(join(repo, p), { force: true, recursive: true });
  }
}

function newDir(ctx) {
  let dir = join(ctx.home, 'salvage', stampOf(ctx.deps.now()));
  for (let n = 2; existsSync(dir); n++) dir = join(ctx.home, 'salvage', `${stampOf(ctx.deps.now())}-${n}`);
  return dir;
}

// Keep `bytes` (a meta file's lost content) as <salvage>/meta/<rel>. -> the salvage directory
export function salvageFile(ctx, rel, bytes, reason) {
  const dir = newDir(ctx);
  const to = join(dir, 'meta', rel);
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, bytes);
  ctx.deps.log(`salvaged ${rel} -> ${to} (${reason})`);
  return dir;
}

// Salvage the meta clone's dirty files (all, or `paths`) and, unless `code: false`, every dirty checkout
// under workspace/. Returns the salvage directory, or null when nothing was dirty.
export function salvage(ctx, { paths, code = true, reason }) {
  const { clone, deps } = ctx;
  const dir = newDir(ctx);
  const log = (m) => deps.log(`${m} (${reason})`);
  let any = false;
  const meta = dirtyPaths(clone, paths, { skipWorkspace: true });
  if (meta.length) { moveAside(clone, meta, join(dir, 'meta'), log, ''); any = true; }
  if (code) {
    const ws = join(clone, 'workspace');
    for (const key of existsSync(ws) ? readdirSync(ws).filter((k) => !k.startsWith('.')) : []) {
      const repo = join(ws, key);
      if (!existsSync(join(repo, '.git'))) continue;
      const dirty = dirtyPaths(repo);
      if (dirty.length) { moveAside(repo, dirty, join(dir, 'workspace', key), log, `workspace/${key}/`); any = true; }
    }
  }
  return any ? dir : null;
}
