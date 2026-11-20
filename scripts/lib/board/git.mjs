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

export function sync(clone) {
  git(clone, ['fetch', 'origin', 'main']);
  if (git(clone, ['merge', '--ff-only', '--autostash', 'origin/main'], { allowFail: true }) === null) {
    throw new BoardError('cannot fast-forward to origin/main');
  }
}

export function assertOnMain(clone) {
  const branch = git(clone, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (branch !== 'main') throw new BoardError('not on main');
}

// Drop our commit(s) but keep unrelated dirty files.
function resetToOrigin(clone) {
  git(clone, ['reset', '--keep', 'origin/main']);
}

export async function boardWrite(clone, {
  kind, subject, trailers = {}, identity, mutate, validate, onReject, hooks = {}, sleep = defaultSleep,
}) {
  const message = formatMessage({ kind, subject, trailers });
  const emptyOk = EMPTY_COMMIT_KINDS.has(kind);
  assertOnMain(clone);
  sync(clone);

  const paths = mutate(clone);
  const env = {
    GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email,
  };
  if (paths.length === 0) {
    if (!emptyOk) return { ok: false, reason: 'nothing-to-do' };
    git(clone, ['commit', '--allow-empty', '-F', '-'], { input: message, env });
  } else {
    git(clone, ['add', '--', ...paths]);
    if (!emptyOk && git(clone, ['diff', '--cached', '--quiet', '--', ...paths], { allowFail: true }) !== null) {
      return { ok: false, reason: 'nothing-to-do' };
    }
    git(clone, ['commit', '--only', '--allow-empty', '-F', '-', '--', ...paths], { input: message, env });
  }

  let pushed = false;
  for (let attempt = 1; ; attempt++) {
    hooks.beforePush?.();
    if (git(clone, ['push', 'origin', 'HEAD:main'], { allowFail: true }) !== null) { pushed = true; break; }

    git(clone, ['fetch', 'origin', 'main']);
    if (onReject !== 'rebase' || attempt >= MAX_REBASE_ATTEMPTS) {
      resetToOrigin(clone);
      return { ok: false, reason: 'lost-race' };
    }
    if (git(clone, ['rebase', '--autostash', 'origin/main'], { allowFail: true }) === null) {
      git(clone, ['rebase', '--abort'], { allowFail: true });
      resetToOrigin(clone);
      return { ok: false, reason: 'conflict' };
    }
    if (!emptyOk && git(clone, ['rev-list', '--count', 'origin/main..HEAD']).trim() === '0') {
      return { ok: false, reason: 'nothing-to-do' }; // our change is already on main
    }
    await sleep(jitterMs());
  }

  const sha = git(clone, ['rev-parse', 'HEAD']).trim();
  if (pushed) {
    sync(clone);
    if (git(clone, ['merge-base', '--is-ancestor', sha, 'origin/main'], { allowFail: true }) === null) {
      return { ok: false, reason: 'replaced' };
    }
    if (validate && !validate(clone)) return { ok: false, reason: 'replaced' };
  }
  return { ok: true, sha };
}
