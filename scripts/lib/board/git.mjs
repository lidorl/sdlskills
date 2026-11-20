// The board write primitive: every board change goes through boardWrite.
// pull -> mutate -> commit only touched paths -> push to main -> (on reject: restart | rebase-retry)
// -> after push confirm the commit is on origin/main and validate() still holds. Never forces a push.
import { execFileSync } from 'node:child_process';
import { formatMessage } from './events.mjs';

export class BoardError extends Error {}

const EMPTY_COMMIT_KINDS = new Set(['start', 'stop', 'crash', 'renew']);
const MAX_REBASE_ATTEMPTS = 5;

function git(clone, args, { input, env, allowFail } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: clone, encoding: 'utf8', input, env: env ? { ...process.env, ...env } : process.env,
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

export function assertOnMain(clone) {
  const branch = git(clone, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (branch !== 'main') throw new BoardError('not on main');
}

// Put HEAD at origin/main (our unpushed commit goes away), keeping unrelated dirty files.
// If --keep refuses (a dirty file differs on origin), stash, hard-reset, pop; on a conflicting pop the
// dirty work stays in the stash and the clone is clean at origin/main.
function restoreToOrigin(clone, env, keepWork = false) {
  // keep-work: the caller's files (including ones our commit added) stay on disk, uncommitted and unstaged.
  if (keepWork) { git(clone, ['reset', '--mixed', 'origin/main'], { env }); return; }
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

// Identity for every commit-creating git call (commit, rebase, stash, autostash), never the clone's config.
export function identityEnv(identity) {
  return {
    GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email,
  };
}

export async function boardWrite(clone, {
  kind, subject, trailers = {}, identity, mutate, validate, onReject, onFailure = 'discard', hooks = {}, sleep = defaultSleep,
}) {
  const keepWork = onFailure === 'keep-work';
  const message = formatMessage({ kind, subject, trailers });
  const emptyOk = EMPTY_COMMIT_KINDS.has(kind);
  const env = identityEnv(identity);
  assertOnMain(clone);
  sync(clone, env);
  if (git(clone, ['rev-list', '--count', 'origin/main..HEAD']).trim() !== '0') {
    throw new BoardError('local commits ahead of origin/main');
  }

  const paths = mutate(clone);
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
      hooks.beforePush?.();
      if (git(clone, ['push', 'origin', 'HEAD:main'], { env, allowFail: true }) !== null) { landed = true; break; }

      git(clone, ['fetch', 'origin', 'main'], { env });
      if (onReject !== 'rebase' || attempt >= MAX_REBASE_ATTEMPTS) {
        restoreToOrigin(clone, env, keepWork);
        return { ok: false, reason: 'lost-race' };
      }
      if (git(clone, ['rebase', '--autostash', 'origin/main'], { env, allowFail: true }) === null) {
        git(clone, ['rebase', '--abort'], { env, allowFail: true });
        restoreToOrigin(clone, env, keepWork);
        return { ok: false, reason: 'conflict' };
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
