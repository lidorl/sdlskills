// The board write primitive: every board change goes through boardWrite.
// pull -> mutate -> commit only touched paths -> push to main -> (on reject: restart | rebase-retry)
// -> after push confirm the commit is on origin/main and validate() still holds. Never forces a push.
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

// The docs a protocol write may patch. A person's uncommitted edits there are set aside while the write runs.
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

// Remember each dirty work file: the person's copy (bytes and mode, null if deleted) and HEAD's copy.
function snapshotWork(clone, env) {
  return dirtyWork(clone, env).map((path) => {
    let abs;
    try { abs = safePath(clone, path); } catch (e) { throw new BoardError(e.message); }
    const working = existsSync(abs) ? { bytes: readFileSync(abs), mode: statSync(abs).mode & 0o777 } : null;
    return { path, abs, working, base: headBytes(clone, path) };
  });
}

// Put HEAD's copy of each remembered file in the tree, so a protocol write patches only committed content.
function resetWork(saved) {
  for (const { abs, base } of saved) {
    if (base === null) rmSync(abs, { force: true });
    else { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, base); }
  }
}

// Three-way merge of the person's copy onto HEAD's new copy; null when they conflict.
function mergeBytes(mine, base, theirs) {
  const dir = mkdtempSync(join(tmpdir(), 'board-merge-'));
  try {
    const [m, b, t] = ['mine', 'base', 'theirs'].map((n, i) => { const f = join(dir, n); writeFileSync(f, [mine, base, theirs][i]); return f; });
    return execFileSync('git', ['merge-file', '-p', '-q', m, b, t], { encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; } finally { rmSync(dir, { recursive: true, force: true }); }
}

// Give the person their copies back. Where the write (or upstream) changed the same file, their edits are
// merged onto the new HEAD copy; if that conflicts, their copy is left exactly as it was.
function putBackWork(clone, saved) {
  for (const { path, abs, working, base } of saved) {
    if (working === null) { rmSync(abs, { force: true }); continue; }
    let bytes = working.bytes;
    const now = headBytes(clone, path);
    if (base && now && !now.equals(base)) bytes = mergeBytes(working.bytes, base, now) ?? working.bytes;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
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

// Identity for every commit-creating git call (commit, rebase, stash, autostash), never the clone's config.
export function identityEnv(identity) {
  return {
    GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email,
  };
}

// commitFromHead: mutate patches the committed (HEAD) copies of the docs, never a person's uncommitted edits;
// those are set aside first and given back afterwards. Every protocol write uses it; `sdlc report`, which
// publishes the working tree on purpose, does not.
export async function boardWrite(clone, { commitFromHead = false, ...opts }) {
  const message = formatMessage({ kind: opts.kind, subject: opts.subject, trailers: opts.trailers ?? {} });
  const env = identityEnv(opts.identity);
  assertOnMain(clone);
  sync(clone, env);
  if (git(clone, ['rev-list', '--count', 'origin/main..HEAD']).trim() !== '0') {
    throw new BoardError('local commits ahead of origin/main');
  }
  const saved = snapshotWork(clone, env);
  if (commitFromHead) resetWork(saved);
  try {
    return await commitAndPush(clone, opts, { message, env, saved, commitFromHead });
  } finally {
    if (commitFromHead) putBackWork(clone, saved);
  }
}

async function commitAndPush(clone, {
  kind, mutate, validate, onReject, onFailure = 'discard', hooks = {}, sleep = defaultSleep,
}, { message, env, saved, commitFromHead }) {
  const keepWork = onFailure === 'keep-work';
  const emptyOk = EMPTY_COMMIT_KINDS.has(kind);

  let paths;
  try {
    paths = mutate(clone);
  } catch (e) {
    // Leave no half-written docs for the next write to read; the person's own copies come back.
    rollbackWork(clone, env);
    if (!commitFromHead) putBackWork(clone, saved);
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
