// The board write primitive: every board change goes through boardWrite.
// pull -> mutate -> commit only touched paths -> push to main -> (on reject: restart | rebase-retry)
// -> after push confirm the commit is on origin/main and validate() still holds. Never forces a push.
// Protocol writes (commitFromHead) build their commit off the working tree entirely; see writeFromHead.
import { execFileSync } from 'node:child_process';
import {
  mkdirSync, writeFileSync, unlinkSync, readFileSync, existsSync, statSync, chmodSync, rmSync, mkdtempSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { formatMessage } from './events.mjs';
import { safePath } from './safe-path.mjs';

export class BoardError extends Error {}

const EMPTY_COMMIT_KINDS = new Set(['start', 'stop', 'crash', 'renew']);
const MAX_REBASE_ATTEMPTS = 5;

function git(clone, args, { input, env, allowFail, binary } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: clone, encoding: binary ? 'buffer' : 'utf8', input, env: env ? { ...process.env, ...env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    if (allowFail) return null;
    throw e;
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitterMs = () => 50 + Math.floor(Math.random() * 201);

const UNMERGED_MSG = 'local changes conflict with origin/main; saved in git stash';

function hasUnmerged(clone) {
  return git(clone, ['diff', '--name-only', '--diff-filter=U']).trim() !== '';
}

export function sync(clone, env) {
  git(clone, ['fetch', 'origin', 'main'], { env });
  if (git(clone, ['merge', '--ff-only', '--autostash', 'origin/main'], { env, allowFail: true }) === null) {
    throw new BoardError('cannot fast-forward to origin/main');
  }
  if (hasUnmerged(clone)) { // autostash pop conflicted; the stash entry is kept
    git(clone, ['reset', '--hard', 'HEAD'], { env });
    throw new BoardError(UNMERGED_MSG);
  }
}

// Read commands: update origin/main only. Never moves HEAD, the index or the working tree.
export function fetchMain(clone, env) {
  git(clone, ['fetch', 'origin', 'main'], { env });
}

// A throwaway copy of origin/main's docs/ and board/ to read the board from, whatever branch or edits the clone has.
export function snapshotMain(clone) {
  const dir = mkdtempSync(join(tmpdir(), 'board-main-'));
  try {
    const present = git(clone, ['ls-tree', '--name-only', 'origin/main', '--', 'docs', 'board']).split('\n').filter(Boolean);
    if (present.length) {
      const tar = git(clone, ['archive', '--format=tar', 'origin/main', '--', ...present], { binary: true });
      execFileSync('tar', ['-x', '-f', '-', '-C', dir], { input: tar, stdio: ['pipe', 'ignore', 'pipe'] });
    }
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw new BoardError(`cannot read origin/main: ${String(e.message).split('\n')[0]}`);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function assertOnMain(clone) {
  const branch = git(clone, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (branch !== 'main') throw new BoardError('not on main');
}

// Put HEAD at origin/main (our unpushed commit goes away), keeping unrelated dirty files.
// If --keep refuses (a dirty file differs on origin), stash, hard-reset, pop; on a conflicting pop the
// dirty work stays in the stash and the clone is clean at origin/main.
function restoreToOrigin(clone, env, keepWork = false) {
  if (!keepWork) { discardToOrigin(clone, env); return {}; }
  // keep-work: restore to origin/main exactly as discard does, then give back our own non-protocol files.
  let ours = null;
  try {
    const sha = git(clone, ['rev-parse', 'HEAD'], { env }).trim();
    if (git(clone, ['rev-list', '--count', 'origin/main..HEAD'], { env }).trim() !== '0') {
      // raw records: ":<old mode> <new mode> <old sha> <new sha> <status>\0<path>\0"
      const toks = git(clone, ['diff-tree', '--no-commit-id', '--no-renames', '-r', '-z', 'HEAD'], { env }).split('\0').filter(Boolean);
      const files = [];
      for (let i = 0; i + 1 < toks.length; i += 2) {
        const meta = toks[i].split(' ');
        files.push({ status: meta[4][0], mode: meta[1], path: toks[i + 1] });
      }
      ours = { sha, files };
    }
  } catch { ours = null; }
  discardToOrigin(clone, env);
  const out = { kept: [], conflicted: [] };
  if (!ours) return out;
  const blob = (rev, path) => git(clone, ['rev-parse', '-q', '--verify', `${rev}:${path}`], { env, allowFail: true })?.trim() ?? null;
  const ourBytes = (path) => git(clone, ['cat-file', 'blob', `${ours.sha}:${path}`], { env, binary: true });
  const write = (abs, path, mode) => {
    writeFileSync(abs, ourBytes(path));
    if (mode === '100755') chmodSync(abs, 0o755);
  };
  const short = ours.sha.slice(0, 7);
  for (const { status, mode, path } of ours.files) {
    if (isProtocol(path)) continue;
    try {
      const untouchedUpstream = blob('origin/main', path) === blob(`${ours.sha}~1`, path);
      if (untouchedUpstream) {
        const abs = safePath(clone, path);
        if (status === 'D') unlinkSync(abs);
        else { mkdirSync(dirname(abs), { recursive: true }); write(abs, path, mode); }
        out.kept.push(path);
      } else {
        if (status !== 'D') write(safePath(clone, `${path}.ours-${short}`), path, mode);
        out.conflicted.push(path);
      }
    } catch { out.conflicted.push(path); }
  }
  return out;
}

function discardToOrigin(clone, env) {
  if (git(clone, ['reset', '--keep', 'origin/main'], { env, allowFail: true }) !== null) return;
  const stashRef = () => git(clone, ['rev-parse', '-q', '--verify', 'refs/stash'], { env, allowFail: true });
  const before = stashRef();
  git(clone, ['stash', 'push', '--include-untracked'], { env });
  const stashed = stashRef() !== before;
  git(clone, ['reset', '--hard', 'origin/main'], { env });
  if (stashed && git(clone, ['stash', 'pop'], { env, allowFail: true }) === null) {
    git(clone, ['reset', '--hard', 'HEAD'], { env });
    throw new BoardError(UNMERGED_MSG);
  }
  if (stashed && hasUnmerged(clone)) {
    git(clone, ['reset', '--hard', 'HEAD'], { env });
    throw new BoardError(UNMERGED_MSG);
  }
}

const isProtocol = (path) => path.startsWith('docs/feat-req/') || path.startsWith('board/');

// The docs a protocol write may patch; a failed report puts the person's copies of these back.
const WORK_DIRS = ['docs/feat-req', 'docs/design', 'docs/plans', 'board'];

// A committed file's text at `ref`, or null when it isn't there.
export function showFile(clone, ref, path) {
  return git(clone, ['show', `${ref}:${path}`], { allowFail: true });
}

const headBytes = (clone, path) => git(clone, ['cat-file', 'blob', `HEAD:${path}`], { allowFail: true, binary: true });

// Paths under WORK_DIRS whose working copy differs from HEAD, untracked files included.
function dirtyWork(clone, env) {
  const out = git(clone, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--', ...WORK_DIRS], { env });
  return out.split('\0').filter(Boolean).map((rec) => rec.slice(3));
}

// Remember each dirty work file: the person's copy (bytes and mode), or null if they deleted it.
function snapshotWork(clone, env) {
  return dirtyWork(clone, env).map((path) => {
    let abs;
    try { abs = safePath(clone, path); } catch (e) { throw new BoardError(e.message); }
    const working = existsSync(abs) ? { bytes: readFileSync(abs), mode: statSync(abs).mode & 0o777 } : null;
    return { abs, working };
  });
}

function putBackWork(saved) {
  for (const { abs, working } of saved) {
    if (working === null) { rmSync(abs, { force: true }); continue; }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, working.bytes);
    chmodSync(abs, working.mode);
  }
}

// After a mutate threw: every work file it left changed goes back to HEAD, every new one is removed.
function rollbackWork(clone, env) {
  const changed = dirtyWork(clone, env);
  const tracked = changed.filter((p) => headBytes(clone, p) !== null);
  if (tracked.length) git(clone, ['checkout', 'HEAD', '--', ...tracked], { env });
  for (const p of changed.filter((x) => !tracked.includes(x))) rmSync(safePath(clone, p), { force: true });
}

// The board docs as committed at `ref`: what a protocol write's mutate patches and what validate reads.
// read(path) -> text | null; exists(path); list(dir) -> names; write(path, text); remove(path).
// Writes stay in memory. Paths must be under docs/ or board/, and a symlink anywhere on the path is refused.
const TREE_ROOTS = ['docs', 'board'];

function openTree(clone, ref, { readOnly = false } = {}) {
  const entries = new Map(); // path -> { mode, sha }
  const out = git(clone, ['ls-tree', '-r', '-z', '--full-tree', ref, '--', ...TREE_ROOTS]);
  for (const rec of out.split('\0').filter(Boolean)) {
    const tab = rec.indexOf('\t');
    const [mode, , sha] = rec.slice(0, tab).split(' ');
    entries.set(rec.slice(tab + 1), { mode, sha });
  }
  const pending = new Map(); // path -> text, or null for a removal
  const live = () => {
    const paths = new Set([...entries.keys()].filter((p) => !pending.has(p)));
    for (const [p, text] of pending) if (text !== null) paths.add(p);
    return paths;
  };
  const isDir = (rel) => [...live()].some((p) => p.startsWith(`${rel}/`));
  const check = (rel) => {
    const parts = String(rel).split('/');
    if (parts.some((x) => x === '' || x === '.' || x === '..') || rel.includes('\\')) throw new BoardError(`path escapes the repository: ${rel}`);
    if (!TREE_ROOTS.includes(parts[0])) throw new BoardError(`not a board path: ${rel}`);
    for (let i = 1; i <= parts.length; i++) {
      if (entries.get(parts.slice(0, i).join('/'))?.mode === '120000') throw new BoardError(`refusing symlinked path: ${rel}`);
    }
    return rel;
  };
  const read = (rel) => {
    check(rel);
    if (pending.has(rel)) return pending.get(rel);
    const e = entries.get(rel);
    if (e) return git(clone, ['cat-file', 'blob', e.sha]);
    if (isDir(rel)) throw new BoardError(`is a directory: ${rel}`);
    return null;
  };
  const writable = () => { if (readOnly) throw new BoardError('read-only view'); };
  const tree = {
    read,
    exists: (rel) => { check(rel); return live().has(rel) || isDir(rel); },
    list: (dir) => {
      check(dir);
      const names = new Set();
      for (const p of live()) if (p.startsWith(`${dir}/`)) names.add(p.slice(dir.length + 1).split('/')[0]);
      return [...names].sort();
    },
    write: (rel, text) => { writable(); check(rel); pending.set(rel, String(text)); },
    remove: (rel) => { writable(); check(rel); pending.set(rel, null); },
  };
  return { tree, entries, pending };
}

const mainView = (clone) => openTree(clone, 'origin/main', { readOnly: true }).tree;

// The commit for a protocol write, built in a throwaway index on `parent`; the real index and working
// tree are never read or written. `changes` lists each path whose blob changed (old/new sha, null = absent).
function buildCommit(clone, { entries, pending }, parent, { message, env }) {
  const dir = mkdtempSync(join(tmpdir(), 'board-index-'));
  const ienv = { ...env, GIT_INDEX_FILE: join(dir, 'index') };
  try {
    git(clone, ['read-tree', parent], { env: ienv });
    const changes = [];
    for (const [path, text] of pending) {
      const before = entries.get(path) ?? null;
      if (text === null) {
        if (!before) continue;
        git(clone, ['update-index', '--force-remove', '--', path], { env: ienv });
        changes.push({ path, mode: before.mode, old: before.sha, new: null });
        continue;
      }
      const sha = git(clone, ['hash-object', '-w', '--stdin'], { input: text, env: ienv }).trim();
      if (before?.sha === sha) continue;
      const mode = before?.mode ?? '100644';
      git(clone, ['update-index', '--add', '--cacheinfo', `${mode},${sha},${path}`], { env: ienv });
      changes.push({ path, mode, old: before?.sha ?? null, new: sha });
    }
    const tree = git(clone, ['write-tree'], { env: ienv }).trim();
    const sha = git(clone, ['commit-tree', tree, '-p', parent, '-F', '-'], { input: message, env: ienv }).trim();
    return { sha, changes };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const blob = (clone, sha) => git(clone, ['cat-file', 'blob', sha], { binary: true });

// One path our landed commit changed: the working file follows only if the person never touched it
// (still the old blob, or absent where there was none); the index entry follows only if it was still the old blob.
function followPath(clone, { path, mode, old, new: next }, env) {
  try {
    const abs = safePath(clone, path); // a symlink on disk: leave it alone
    const st = existsSync(abs) ? statSync(abs) : null;
    const clean = old === null ? st === null : !!st?.isFile() && readFileSync(abs).equals(blob(clone, old));
    if (clean && next === null) rmSync(abs, { force: true });
    else if (clean) { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, blob(clone, next)); }
  } catch { /* the person's copy stays as it is */ }
  const entry = git(clone, ['ls-files', '-s', '-z', '--', path], { env, allowFail: true });
  if (entry === null) return;
  const staged = entry ? entry.split(' ')[1] : null;
  if (staged !== old) return;
  if (next === null) git(clone, ['update-index', '--force-remove', '--', path], { env, allowFail: true });
  else git(clone, ['update-index', '--add', '--cacheinfo', `${mode},${next},${path}`], { env, allowFail: true });
}

// Bring local main up to our landed commit without overwriting anything the person changed.
function followLanded(clone, { sha, parent, changes }, env) {
  if (git(clone, ['symbolic-ref', '-q', 'HEAD'], { env, allowFail: true })?.trim() !== 'refs/heads/main') return;
  const head = () => git(clone, ['rev-parse', 'HEAD'], { env }).trim();
  // Rebuilt on a newer main after a lost push: catch up first (git refuses rather than overwrite edits).
  if (head() !== parent) git(clone, ['merge', '--ff-only', parent], { env, allowFail: true });
  if (head() !== parent) return; // the clone stays behind origin/main; the next sync catches up
  if (git(clone, ['update-ref', 'refs/heads/main', sha, parent], { env, allowFail: true }) === null) return;
  for (const c of changes) followPath(clone, c, env);
  git(clone, ['update-index', '-q', '--refresh'], { env, allowFail: true });
  git(clone, ['merge', '--ff-only', 'origin/main'], { env, allowFail: true });
}

// Identity for every commit-creating git call (commit, rebase, stash, autostash), never the clone's config.
export function identityEnv(identity) {
  return {
    GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email,
  };
}

// commitFromHead (every protocol write): mutate(tree) patches the committed docs through the content API
// above and the commit is built in a temporary index, so the person's working tree and index are never
// read or written while the write runs. validate(view) reads origin/main through the same API.
// `sdlc report`, which publishes the working tree on purpose, uses mutate(clone) and validate(clone).
export async function boardWrite(clone, { commitFromHead = false, ...opts }) {
  const message = formatMessage({ kind: opts.kind, subject: opts.subject, trailers: opts.trailers ?? {} });
  const env = identityEnv(opts.identity);
  assertOnMain(clone);
  sync(clone, env);
  if (git(clone, ['rev-list', '--count', 'origin/main..HEAD']).trim() !== '0') {
    throw new BoardError('local commits ahead of origin/main');
  }
  if (commitFromHead) return writeFromHead(clone, opts, { message, env });
  return commitAndPush(clone, opts, { message, env, saved: snapshotWork(clone, env) });
}

// On a rejected push nothing local has moved: restart returns lost-race, rebase rebuilds on the new
// origin/main and re-runs mutate (the same as a restart, since nothing of ours is in the working tree).
async function writeFromHead(clone, {
  kind, mutate, validate, onReject, hooks = {}, sleep = defaultSleep,
}, { message, env }) {
  const emptyOk = EMPTY_COMMIT_KINDS.has(kind);
  const step = async (fn) => {
    try { return await fn(); } catch (e) {
      if (e instanceof BoardError) throw e;
      throw new BoardError(`board write failed: ${String(e.message).split('\n')[0]}`);
    }
  };
  for (let attempt = 1; ; attempt++) {
    const parent = await step(() => git(clone, ['rev-parse', 'origin/main'], { env }).trim());
    const opened = await step(() => openTree(clone, parent));
    mutate(opened.tree); // its own errors (refusals, symlinks) go to the caller as they are
    const built = await step(() => buildCommit(clone, opened, parent, { message, env }));
    if (built.changes.length === 0 && !emptyOk) return { ok: false, reason: 'nothing-to-do' };
    await step(() => hooks.beforePush?.());
    if (git(clone, ['push', 'origin', `${built.sha}:refs/heads/main`], { env, allowFail: true }) !== null) {
      return landed(clone, { ...built, parent }, { validate, env });
    }
    await step(() => git(clone, ['fetch', 'origin', 'main'], { env }));
    if (onReject !== 'rebase' || attempt >= MAX_REBASE_ATTEMPTS) return { ok: false, reason: 'lost-race' };
    await sleep(jitterMs());
  }
}

// The write is on origin. Confirm it, but never report a landed write as a plain failure.
function landed(clone, built, { validate, env }) {
  try {
    git(clone, ['fetch', 'origin', 'main'], { env });
  } catch (e) {
    throw new BoardError(`pushed ${built.sha} but could not confirm it on origin/main: ${String(e.message).split('\n')[0]}`);
  }
  if (git(clone, ['merge-base', '--is-ancestor', built.sha, 'origin/main'], { env, allowFail: true }) === null) {
    return { ok: false, reason: 'replaced' };
  }
  followLanded(clone, built, env);
  if (validate && !validate(mainView(clone))) return { ok: false, reason: 'replaced' };
  return { ok: true, sha: built.sha };
}

async function commitAndPush(clone, {
  kind, mutate, validate, onReject, onFailure = 'discard', hooks = {}, sleep = defaultSleep,
}, { message, env, saved }) {
  const keepWork = onFailure === 'keep-work';
  const emptyOk = EMPTY_COMMIT_KINDS.has(kind);

  let paths;
  try {
    paths = mutate(clone);
  } catch (e) {
    // Leave no half-written docs for the next write to read; the person's own copies come back.
    rollbackWork(clone, env);
    putBackWork(saved);
    throw e;
  }
  if (paths.length === 0) {
    if (!emptyOk) return { ok: false, reason: 'nothing-to-do' };
    git(clone, ['commit', '--only', '--allow-empty', '-F', '-'], { input: message, env });
  } else {
    git(clone, ['add', '--', ...paths], { env });
    if (!emptyOk && git(clone, ['diff', '--cached', '--quiet', '--', ...paths], { allowFail: true }) !== null) {
      return { ok: false, reason: 'nothing-to-do' };
    }
    git(clone, ['commit', '--only', '--allow-empty', '-F', '-', '--', ...paths], { input: message, env });
  }

  // Our commit is now on local main. Until the push lands, every exit must leave HEAD at origin/main.
  let landed = false;
  try {
    for (let attempt = 1; ; attempt++) {
      await hooks.beforePush?.();
      if (git(clone, ['push', 'origin', 'HEAD:main'], { env, allowFail: true }) !== null) { landed = true; break; }

      git(clone, ['fetch', 'origin', 'main'], { env });
      if (onReject !== 'rebase' || attempt >= MAX_REBASE_ATTEMPTS) {
        return { ok: false, reason: 'lost-race', ...restoreToOrigin(clone, env, keepWork) };
      }
      if (git(clone, ['rebase', '--autostash', 'origin/main'], { env, allowFail: true }) === null) {
        git(clone, ['rebase', '--abort'], { env, allowFail: true });
        return { ok: false, reason: 'conflict', ...restoreToOrigin(clone, env, keepWork) };
      }
      if (hasUnmerged(clone)) { // autostash pop conflicted: nothing of ours has been pushed yet
        git(clone, ['reset', '--hard', 'HEAD'], { env });
        restoreToOrigin(clone, env, keepWork);
        throw new BoardError(UNMERGED_MSG);
      }
      if (git(clone, ['rev-list', '--count', 'origin/main..HEAD'], { env }).trim() === '0') {
        // The rebase dropped our commit (its change is already on main).
        if (!emptyOk) return { ok: false, reason: 'nothing-to-do' };
        git(clone, ['commit', '--only', '--allow-empty', '-F', '-'], { input: message, env }); // events still need their record
      }
      await sleep(jitterMs());
    }
  } catch (e) {
    if (!landed) {
      try { restoreToOrigin(clone, env, keepWork); } catch { /* the original error is what matters */ }
    }
    if (e instanceof BoardError) throw e;
    throw new BoardError(`board write failed: ${String(e.message).split('\n')[0]}`);
  }

  // The write is on origin. Confirm it, but never report a landed write as a plain failure.
  const sha = git(clone, ['rev-parse', 'HEAD'], { env }).trim();
  try {
    git(clone, ['fetch', 'origin', 'main'], { env });
  } catch (e) {
    throw new BoardError(`pushed ${sha} but could not confirm it on origin/main: ${String(e.message).split('\n')[0]}`);
  }
  if (git(clone, ['merge-base', '--is-ancestor', sha, 'origin/main'], { env, allowFail: true }) === null) {
    return { ok: false, reason: 'replaced' };
  }
  // Fast-forward when clean; if a dirty file blocks it the clone stays at our (pushed) sha, which is fine.
  git(clone, ['merge', '--ff-only', 'origin/main'], { env, allowFail: true });
  if (validate && !validate(clone)) return { ok: false, reason: 'replaced' };
  return { ok: true, sha };
}
