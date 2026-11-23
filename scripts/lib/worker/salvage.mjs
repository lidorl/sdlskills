// Ruling P2-11: the worker's clone and code checkouts are private, so leftover edits (a lost effort, a report
// that did not land, a stray) would block every later effort and no person could reach them. They move to
// <home>/salvage/<stamp>/ (same relative paths, each one logged) and the clone goes back to HEAD.
import { execFileSync } from 'node:child_process';
import {
  constants as fsConstants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';

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

// A path with a symlink among its parents: reading or restoring it would go through the link.
function underLink(repo, path) {
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    if (lstatSync(join(repo, ...parts.slice(0, i)), { throwIfNoEntry: false })?.isSymbolicLink()) return true;
  }
  return false;
}

// Make `to`'s parent directory; -> false unless it resolves inside `root` (nothing is ever written through a link).
function destInside(root, to) {
  mkdirSync(dirname(to), { recursive: true });
  const r = realpathSync(root);
  const p = realpathSync(dirname(to));
  return p === r || p.startsWith(`${r}${sep}`);
}

// `to`, or `to~2`, `to~3`, ... when that name is already taken under salvage.
function freeName(to) {
  let name = to;
  for (let n = 2; lstatSync(name, { throwIfNoEntry: false }); n++) name = `${to}~${n}`;
  return name;
}

const firstLine = (e) => String(e?.message ?? e).split('\n')[0];

// Copy each dirty file under `dest`, then put the repo back to HEAD for those paths. A symlink is kept as
// `<path>.symlink`, a text file holding its target: no link is ever created under salvage/ and the target is
// never read. A path under a symlinked parent is skipped (logged): it is restored from HEAD once the link is gone.
// Each path is handled on its own: one that cannot be saved is logged and left in place, never discarded.
function moveAside(repo, dirty, dest, log, label) {
  mkdirSync(dest, { recursive: true });
  const linked = []; // under a symlinked parent: nothing of the repo's own to save, restored from HEAD below
  const saved = [];
  for (const d of dirty) {
    const { path } = d;
    try {
      const src = join(repo, path);
      if (underLink(repo, path)) { log(`skipped ${label}${path}: a parent is a symlink (not read through it)`); linked.push(d); continue; }
      const st = lstatSync(src, { throwIfNoEntry: false });
      if (st?.isSymbolicLink() || st?.isFile()) {
        const want = join(dest, st.isSymbolicLink() ? `${path}.symlink` : path);
        if (!destInside(dest, want)) { log(`skipped ${label}${path}: its salvage path ${want} leaves ${dest}; left in place`); continue; }
        const to = freeName(want);
        if (st.isSymbolicLink()) {
          const target = readlinkSync(src);
          writeFileSync(to, target, { flag: 'wx' });
          log(`salvaged ${label}${path} -> ${to} (symlink to ${target})`);
        } else {
          copyFileSync(src, to, fsConstants.COPYFILE_EXCL);
          log(`salvaged ${label}${path} -> ${to}`);
        }
      } else {
        log(`salvaged ${label}${path} (deleted locally; restored from HEAD)`);
      }
      saved.push(d);
    } catch (e) {
      log(`could not salvage ${label}${path} (${firstLine(e)}); left in place`);
    }
  }
  const undo = (list, what, fn) => {
    for (const d of list) {
      try { fn(d.path); } catch (e) { log(`warning: could not ${what} ${label}${d.path}: ${firstLine(e)}`); }
    }
  };
  undo(saved.filter((d) => !d.inHead), 'remove', (p) => {
    git(repo, ['rm', '-q', '-r', '--cached', '--ignore-unmatch', '--', p]);
    const abs = join(repo, p);
    if (lstatSync(abs, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(abs); // rmSync misses a dangling link
    else rmSync(abs, { force: true, recursive: true });
  });
  const restore = (p) => git(repo, ['checkout', 'HEAD', '--', p]);
  undo(saved.filter((d) => d.inHead), 'restore', restore);
  // With the links gone, the skipped tracked paths can come back from HEAD.
  undo(linked.filter((d) => d.inHead && !underLink(repo, d.path)), 'restore', restore);
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
  // A symlinked workspace or checkout points at a repo outside the clone: never run git or rm against it.
  const linkedDir = (rel) => {
    if (!lstatSync(join(clone, rel), { throwIfNoEntry: false })?.isSymbolicLink()) return false;
    log(`skipped ${rel}: it is a symlink (not salvaged through it)`);
    return true;
  };
  if (code && !linkedDir('workspace')) {
    const ws = join(clone, 'workspace');
    for (const key of existsSync(ws) ? readdirSync(ws).filter((k) => !k.startsWith('.')) : []) {
      const repo = join(ws, key);
      if (linkedDir(`workspace/${key}`)) continue;
      if (!existsSync(join(repo, '.git'))) continue;
      const dirty = dirtyPaths(repo);
      if (dirty.length) { moveAside(repo, dirty, join(dir, 'workspace', key), log, `workspace/${key}/`); any = true; }
    }
  }
  return any ? dir : null;
}
