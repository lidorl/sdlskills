// The report write, shared by `sdlc report` and the worker: publish an effort's working docs to main as
// the holder, with the protocol fields taken from main and only renewed_at moving.
import { execFileSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, existsSync, statSync, chmodSync, rmSync, mkdtempSync, mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { assertOnMain, boardWrite, BoardError } from './git.mjs';
import { committedFm, featReqPath, NOT_HOLDABLE } from './claims.mjs';
import { parseDoc, setFields } from './frontmatter.mjs';
import { reportPaths } from './paths.mjs';
import { safePath } from './safe-path.mjs';

export const PROTOCOL_FIELDS = ['claimed_by', 'claimed_at', 'renewed_at', 'awaiting'];
const FEAT_REQ_RE = /^docs\/feat-req\/[^/]+\.md$/;
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

export class SyncConflict extends BoardError {
  constructor(paths) {
    super(`local changes conflict with origin/main: ${paths.join(', ')}`);
    this.paths = paths;
  }
}

function git(clone, args, { env, input, allowFail, binary } = {}) {
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

const show = (clone, ref, path) => git(clone, ['cat-file', 'blob', `${ref}:${path}`], { binary: true, allowFail: true });

// A feat-req's protocol fields set to `from`'s values, so they never take part in a 3-way merge.
function withProtocolFields(text, from) {
  try {
    const fm = parseDoc(from).data ?? {};
    return setFields(text, Object.fromEntries(PROTOCOL_FIELDS.map((k) => [k, fm[k] ?? null])));
  } catch { return text; }
}

// git merge-file on three texts; null when they conflict.
function mergeTexts(clone, ours, base, theirs) {
  const dir = mkdtempSync(join(tmpdir(), 'board-merge-'));
  try {
    const f = (name, text) => { const p = join(dir, name); writeFileSync(p, text); return p; };
    return git(clone, ['merge-file', '-p', f('ours', ours), f('base', base), f('theirs', theirs)], { allowFail: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Fast-forward to origin/main, carrying the working tree's edits along without a stash. A dirty file that
// origin/main also changed is merged 3-way here; in a feat-req the protocol fields are main's (they only
// ever change through protocol writes), so a renew next to the agent's status edit is not a conflict.
// Any real conflict throws SyncConflict before anything is touched: the edits stay exactly as they were.
// `fetch: false` when the caller has just fetched.
export function syncKeepingWork(clone, env, { fetch = true } = {}) {
  if (fetch) git(clone, ['fetch', 'origin', 'main'], { env });
  const head = git(clone, ['rev-parse', 'HEAD'], { env }).trim();
  if (head === git(clone, ['rev-parse', 'origin/main'], { env }).trim()) return;
  if (git(clone, ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], { env, allowFail: true }) === null) {
    throw new BoardError('cannot fast-forward to origin/main');
  }
  const dirty = git(clone, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'], { env })
    .split('\0').filter(Boolean).map((rec) => rec.slice(3));
  const upstream = new Set(git(clone, ['diff', '--name-only', '-z', 'HEAD', 'origin/main'], { env }).split('\0').filter(Boolean));
  const merged = new Map();
  const conflicts = [];
  for (const path of dirty.filter((p) => upstream.has(p))) {
    const abs = safePath(clone, path);
    const ours = existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs) : null;
    const base = show(clone, 'HEAD', path);
    const theirs = show(clone, 'origin/main', path);
    if (ours && theirs && ours.equals(theirs)) { merged.set(path, { bytes: ours, inHead: !!base }); continue; }
    if (!ours || !base || !theirs) { conflicts.push(path); continue; }
    let o = ours.toString('utf8');
    let b = base.toString('utf8');
    const t = theirs.toString('utf8');
    if (FEAT_REQ_RE.test(path)) { o = withProtocolFields(o, t); b = withProtocolFields(b, t); }
    const m = mergeTexts(clone, o, b, t);
    if (m === null) conflicts.push(path);
    else merged.set(path, { bytes: Buffer.from(m, 'utf8'), inHead: true });
  }
  if (conflicts.length) throw new SyncConflict(conflicts);

  const saved = [...merged.keys()].map((path) => {
    const abs = safePath(clone, path);
    return { path, abs, bytes: readFileSync(abs), mode: statSync(abs).mode & 0o777 };
  });
  const putBack = (pick) => {
    for (const s of saved) {
      mkdirSync(dirname(s.abs), { recursive: true });
      writeFileSync(s.abs, pick(s));
      chmodSync(s.abs, s.mode);
    }
  };
  // Clear the way for the fast-forward: tracked files back to HEAD, files HEAD lacks out of the tree.
  const tracked = saved.filter((x) => merged.get(x.path).inHead).map((x) => x.path);
  const untracked = saved.filter((x) => !merged.get(x.path).inHead).map((x) => x.path);
  if (tracked.length) git(clone, ['checkout', 'HEAD', '--', ...tracked], { env });
  if (untracked.length) git(clone, ['rm', '-q', '--cached', '--ignore-unmatch', '--', ...untracked], { env, allowFail: true });
  for (const s of saved) if (untracked.includes(s.path)) rmSync(s.abs, { force: true });
  if (git(clone, ['merge', '--ff-only', 'origin/main'], { env, allowFail: true }) === null) {
    if (tracked.length) git(clone, ['reset', '-q', '--', ...tracked], { env, allowFail: true });
    putBack((s) => s.bytes);
    throw new BoardError('cannot fast-forward to origin/main');
  }
  putBack((s) => merged.get(s.path).bytes);
}

// Publish the effort's working docs as `claimant`. The holder is whoever main says; the working copy may
// already say IMPLEMENTED/PARKED, which is the report. Returns { ok: true, sha } or { ok: false, reason }:
//   not-holder | closed  — nothing was pushed
//   unmerged             — the edits conflict with main; nothing pushed, the working tree is untouched (paths)
//   conflict | race      — the push lost; non-protocol files kept per keep-work (kept, conflicted), feat-req edits dropped
//   landed               — the report landed but the claim was replaced right after
// `workerId` adds the Worker trailer; `body` adds a paragraph to the commit message; `fetched` skips the
// first fetch when the caller has just fetched.
export async function reportEffort(clone, slug, {
  phase, claimant, identity, workerId, extraPaths = [], now, sleep, hooks, body, fetched = false,
}) {
  assertOnMain(clone);
  const feat = featReqPath(slug);
  const refusal = (fm) => {
    if (!fm || fm.claimed_by !== claimant) return 'not-holder';
    return NOT_HOLDABLE.has(fm.status) ? 'closed' : null;
  };
  const stamp = iso(now);
  let refused = null;
  let r;
  try {
    r = await boardWrite(clone, {
      kind: 'report', subject: slug, body, identity, onReject: 'rebase', onFailure: 'keep-work', hooks, sleep,
      sync: (c, env) => syncKeepingWork(c, env, { fetch: !fetched }), // the holder check is in mutate
      trailers: { ...(workerId ? { worker: workerId } : {}), effort: slug, phase },
      mutate: (c) => {
        const up = committedFm(c, slug);
        refused = refusal(up);
        if (refused) return [];
        // Publish the working copy (the report), but the protocol fields are main's: only renewed_at moves.
        const f = safePath(c, feat);
        writeFileSync(f, setFields(readFileSync(f, 'utf8'), {
          claimed_by: up.claimed_by, claimed_at: up.claimed_at ?? null, renewed_at: stamp, awaiting: up.awaiting ?? null,
        }));
        return reportPaths(c, slug, extraPaths);
      },
      validate: (c) => committedFm(c, slug, 'origin/main')?.claimed_by === claimant,
    });
  } catch (e) {
    if (e instanceof SyncConflict) return { ok: false, reason: 'unmerged', paths: e.paths };
    throw e;
  }
  if (r.ok) return { ok: true, sha: r.sha };
  if (refused) return { ok: false, reason: refused };
  if (r.reason === 'conflict') return { ...r, ok: false, reason: 'conflict' };
  if (r.reason === 'lost-race') return { ...r, ok: false, reason: 'race' };
  if (r.reason === 'replaced') return { ok: false, reason: 'landed' };
  return { ok: false, reason: r.reason };
}
