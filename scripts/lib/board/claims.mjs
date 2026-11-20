// Claim protocol: a claim is a commit on main setting claimed_by/claimed_at/renewed_at in the feat-req
// frontmatter. It counts only once it is on origin/main and validated (boardWrite does both).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { boardWrite, sync, identityEnv, showFile, BoardError } from './git.mjs';
import { parseDoc, setFields, appendToSection } from './frontmatter.mjs';
import { safePath, SLUG_RE } from './safe-path.mjs';

const CLAIM_FIELDS = ['claimed_by', 'claimed_at', 'renewed_at'];
export const NOT_HOLDABLE = new Set(['PARKED', 'REJECTED', 'IMPLEMENTED']);

export function checkSlug(slug) {
  if (!SLUG_RE.test(String(slug))) throw new BoardError(`invalid slug "${slug}"`);
  return slug;
}

export const featReqPath = (slug) => `docs/feat-req/${checkSlug(slug)}.md`;
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

// The working-tree feat-req, through the path guard (a symlinked path throws).
function readFm(clone, slug) {
  const file = safePath(clone, featReqPath(slug));
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  try {
    return { text, fm: parseDoc(text).data ?? {}, file };
  } catch {
    return null;
  }
}

// The feat-req frontmatter as committed at `ref` (no working tree involved); null if absent or unparsable.
export function committedFm(clone, slug, ref = 'HEAD') {
  const text = showFile(clone, ref, featReqPath(slug));
  if (text === null) return null;
  try { return parseDoc(text).data ?? {}; } catch { return null; }
}

export function claimState(fm, now, ttlMs) {
  if (!fm?.claimed_by) return 'unclaimed';
  const since = new Date(fm.renewed_at ?? fm.claimed_at).getTime();
  if (Number.isNaN(since)) return 'stale';
  const age = now.getTime() - since;
  return age < 0 || age <= ttlMs ? 'live' : 'stale';
}

const holdable = (fm, claimant) => !!fm && fm.claimed_by === claimant && !NOT_HOLDABLE.has(fm.status);

// Working tree by default; pass `ref` (e.g. 'origin/main') to ask what is committed there instead.
export function holds(clone, slug, claimant, { ref } = {}) {
  if (ref) return holdable(committedFm(clone, slug, ref), claimant);
  const r = readFm(clone, slug);
  return holdable(r?.fm, claimant);
}

const trailersFor = (slug, workerId, extra = {}) => ({
  ...(workerId ? { worker: workerId } : {}), effort: slug, ...extra,
});

const MAX_ATTEMPTS = 3;
class NotHolder extends Error {}

export async function claim(clone, slug, { claimant, identity, workerId, now, ttlMs, isAwaitingOpen, hooks }) {
  checkSlug(slug);
  const stamp = iso(now);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // The commit kind and Replaces trailer are fixed before boardWrite starts, so peek at the freshly
    // synced commit first. mutate re-reads after boardWrite's own sync and refuses (mismatch) if the
    // state it sees is not the one the kind/trailer describe; we then re-peek and retry.
    sync(clone, identityEnv(identity));
    const peek = committedFm(clone, slug);
    if (holdable(peek, claimant) && claimState(peek, now, ttlMs) === 'live') {
      // Already ours (a retry, or a restarted worker with the same id): refresh the lease instead.
      const r = await renew(clone, slug, { claimant, identity, workerId, now, hooks });
      if (r.ok) return { ok: true, takeover: null };
      if (r.reason === 'replaced') continue;
      return { ok: false, reason: r.reason };
    }
    const stale = !!peek && claimState(peek, now, ttlMs) === 'stale';
    const old = stale ? peek.claimed_by : null;
    hooks?.afterPeek?.();
    let refusal = null;
    const r = await boardWrite(clone, {
      kind: stale ? 'takeover' : 'claim', subject: slug, identity, onReject: 'restart', hooks, commitFromHead: true,
      trailers: trailersFor(slug, workerId, stale ? { replaces: old } : {}),
      mutate: (c) => {
        const cur = readFm(c, slug);
        if (!cur) { refusal = 'gone'; return []; }
        if (NOT_HOLDABLE.has(cur.fm.status)) { refusal = 'closed'; return []; }
        if (cur.fm.awaiting && isAwaitingOpen(cur.fm)) { refusal = 'awaiting'; return []; }
        const state = claimState(cur.fm, now, ttlMs);
        if (state === 'live') { refusal = cur.fm.claimed_by === claimant ? 'mismatch' : 'held'; return []; }
        if ((state === 'stale') !== stale || (stale && cur.fm.claimed_by !== old)) { refusal = 'mismatch'; return []; }
        let text = setFields(cur.text, { claimed_by: claimant, claimed_at: stamp, renewed_at: stamp });
        if (stale) {
          const since = cur.fm.renewed_at ?? cur.fm.claimed_at;
          text = appendToSection(text, 'Decisions',
            `- ${stamp.slice(0, 10)} · takeover · ${claimant} took over from ${old} (claim stale since ${since})`);
        }
        writeFileSync(cur.file, text);
        return [featReqPath(slug)];
      },
      validate: (c) => committedFm(c, slug, 'origin/main')?.claimed_by === claimant,
    });
    if (r.ok) return { ok: true, takeover: old };
    if (r.reason === 'nothing-to-do' && refusal === 'mismatch') continue;
    if (r.reason === 'nothing-to-do' && refusal) return { ok: false, reason: refusal };
    return { ok: false, reason: r.reason };
  }
  return { ok: false, reason: 'lost-race' };
}

// renew and release restart (never rebase) on a rejected push, so mutate re-checks the holder each time.
async function asHolder(run) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const r = await run().catch((e) => { if (e instanceof NotHolder) return { ok: false, reason: 'replaced' }; throw e; });
    if (r.ok || r.reason !== 'lost-race') return r;
  }
  return { ok: false, reason: 'lost-race' };
}

function requireHolder(c, slug, claimant) {
  const cur = readFm(c, slug);
  if (!cur || cur.fm.claimed_by !== claimant) throw new NotHolder(); // mutate runs before any commit
  return cur;
}

export async function renew(clone, slug, { claimant, identity, workerId, now, hooks }) {
  checkSlug(slug);
  return asHolder(() => boardWrite(clone, {
    kind: 'renew', subject: slug, identity, onReject: 'restart', hooks, commitFromHead: true,
    trailers: trailersFor(slug, workerId),
    mutate: (c) => {
      const cur = requireHolder(c, slug, claimant);
      if (NOT_HOLDABLE.has(cur.fm.status)) throw new NotHolder(); // closed: nothing left to hold
      writeFileSync(cur.file, setFields(cur.text, { renewed_at: iso(now) }));
      return [featReqPath(slug)];
    },
    validate: (c) => holds(c, slug, claimant, { ref: 'origin/main' }),
  }));
}

// kind, subject and trailers override the defaults when the release is part of another event (a blocking request).
export async function release(clone, slug, { claimant, identity, workerId, extraMutate, hooks, kind = 'release', subject = slug, trailers }) {
  checkSlug(slug);
  return asHolder(() => boardWrite(clone, {
    kind, subject, identity, onReject: 'restart', hooks, commitFromHead: true,
    trailers: trailersFor(slug, workerId, trailers),
    mutate: (c) => {
      const cur = requireHolder(c, slug, claimant);
      writeFileSync(cur.file, setFields(cur.text, Object.fromEntries(CLAIM_FIELDS.map((k) => [k, null]))));
      return [featReqPath(slug), ...(extraMutate ? extraMutate(c) : [])];
    },
    validate: (c) => {
      const fm = committedFm(c, slug, 'origin/main');
      return !fm || CLAIM_FIELDS.every((k) => fm[k] == null);
    },
  }));
}
