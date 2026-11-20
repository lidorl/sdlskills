// Claim protocol: a claim is a commit on main setting claimed_by/claimed_at/renewed_at in the feat-req
// frontmatter. It counts only once it is on origin/main and validated (boardWrite does both).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { boardWrite, sync, identityEnv } from './git.mjs';
import { parseDoc, setFields, appendToSection } from './frontmatter.mjs';

const CLAIM_FIELDS = ['claimed_by', 'claimed_at', 'renewed_at'];
const NOT_HOLDABLE = new Set(['PARKED', 'REJECTED', 'IMPLEMENTED']);

const relPath = (slug) => `docs/feat-req/${slug}.md`;
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

function readFm(clone, slug) {
  const file = join(clone, relPath(slug));
  if (!existsSync(file)) return null;
  try {
    return { text: readFileSync(file, 'utf8'), fm: parseDoc(readFileSync(file, 'utf8')).data ?? {}, file };
  } catch {
    return null;
  }
}

export function claimState(fm, now, ttlMs) {
  if (!fm?.claimed_by) return 'unclaimed';
  const since = new Date(fm.renewed_at ?? fm.claimed_at).getTime();
  if (Number.isNaN(since)) return 'stale';
  const age = now.getTime() - since;
  return age < 0 || age <= ttlMs ? 'live' : 'stale';
}

export function holds(clone, slug, claimant) {
  const r = readFm(clone, slug);
  return !!r && r.fm.claimed_by === claimant && !NOT_HOLDABLE.has(r.fm.status);
}

const trailersFor = (slug, workerId, extra = {}) => ({
  ...(workerId ? { worker: workerId } : {}), effort: slug, ...extra,
});

const MAX_ATTEMPTS = 3;
class NotHolder extends Error {}

export async function claim(clone, slug, { claimant, identity, workerId, now, ttlMs, isAwaitingOpen, hooks }) {
  const stamp = iso(now);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // The commit kind and Replaces trailer are fixed before boardWrite starts, so peek at the freshly
    // synced file first. mutate re-reads after boardWrite's own sync and refuses (mismatch) if the
    // state it sees is not the one the kind/trailer describe; we then re-peek and retry.
    sync(clone, identityEnv(identity));
    const peek = readFm(clone, slug);
    const stale = !!peek && claimState(peek.fm, now, ttlMs) === 'stale';
    const old = stale ? peek.fm.claimed_by : null;
    hooks?.afterPeek?.();
    let refusal = null;
    const r = await boardWrite(clone, {
      kind: stale ? 'takeover' : 'claim', subject: slug, identity, onReject: 'restart', hooks,
      trailers: trailersFor(slug, workerId, stale ? { replaces: old } : {}),
      mutate: (c) => {
        const cur = readFm(c, slug);
        if (!cur) { refusal = 'gone'; return []; }
        if (cur.fm.awaiting && isAwaitingOpen(cur.fm)) { refusal = 'awaiting'; return []; }
        const state = claimState(cur.fm, now, ttlMs);
        if (state === 'live') { refusal = 'held'; return []; }
        if ((state === 'stale') !== stale || (stale && cur.fm.claimed_by !== old)) { refusal = 'mismatch'; return []; }
        let text = setFields(cur.text, { claimed_by: claimant, claimed_at: stamp, renewed_at: stamp });
        if (stale) {
          const since = cur.fm.renewed_at ?? cur.fm.claimed_at;
          text = appendToSection(text, 'Decisions',
            `- ${stamp.slice(0, 10)} · takeover · ${claimant} took over from ${old} (claim stale since ${since})`);
        }
        writeFileSync(cur.file, text);
        return [relPath(slug)];
      },
      validate: (c) => readFm(c, slug)?.fm.claimed_by === claimant,
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

export function renew(clone, slug, { claimant, identity, workerId, now, hooks }) {
  return asHolder(() => boardWrite(clone, {
    kind: 'renew', subject: slug, identity, onReject: 'restart', hooks,
    trailers: trailersFor(slug, workerId),
    mutate: (c) => {
      const cur = requireHolder(c, slug, claimant);
      writeFileSync(cur.file, setFields(cur.text, { renewed_at: iso(now) }));
      return [relPath(slug)];
    },
    validate: (c) => holds(c, slug, claimant),
  }));
}

export function release(clone, slug, { claimant, identity, workerId, extraMutate, hooks }) {
  return asHolder(() => boardWrite(clone, {
    kind: 'release', subject: slug, identity, onReject: 'restart', hooks,
    trailers: trailersFor(slug, workerId),
    mutate: (c) => {
      const cur = requireHolder(c, slug, claimant);
      writeFileSync(cur.file, setFields(cur.text, Object.fromEntries(CLAIM_FIELDS.map((k) => [k, null]))));
      return [relPath(slug), ...(extraMutate ? extraMutate(c) : [])];
    },
    validate: (c) => {
      const cur = readFm(c, slug);
      return !cur || CLAIM_FIELDS.every((k) => cur.fm[k] == null);
    },
  }));
}
