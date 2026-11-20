// Claim protocol: a claim is a commit on main setting claimed_by/claimed_at/renewed_at in the feat-req
// frontmatter. It counts only once it is on origin/main and validated (boardWrite does both).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { boardWrite, sync } from './git.mjs';
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

export async function claim(clone, slug, { claimant, identity, workerId, now, ttlMs, isAwaitingOpen, hooks }) {
  // The commit kind and Replaces trailer are fixed before boardWrite starts, so peek at the freshly
  // synced file first; mutate re-reads and makes the real decision on the same state.
  sync(clone);
  const peek = readFm(clone, slug);
  const stale = peek && claimState(peek.fm, now, ttlMs) === 'stale';
  const old = stale ? peek.fm.claimed_by : null;
  let refusal = null;
  const stamp = iso(now);
  const r = await boardWrite(clone, {
    kind: stale ? 'takeover' : 'claim', subject: slug, identity, onReject: 'restart', hooks,
    trailers: trailersFor(slug, workerId, stale ? { replaces: old } : {}),
    mutate: (c) => {
      const cur = readFm(c, slug);
      if (!cur) { refusal = 'gone'; return []; }
      if (cur.fm.awaiting && isAwaitingOpen(cur.fm)) { refusal = 'awaiting'; return []; }
      const state = claimState(cur.fm, now, ttlMs);
      if (state === 'live') { refusal = 'held'; return []; }
      let text = setFields(cur.text, { claimed_by: claimant, claimed_at: stamp, renewed_at: stamp });
      if (state === 'stale') {
        const since = cur.fm.renewed_at ?? cur.fm.claimed_at;
        text = appendToSection(text, 'Decisions',
          `- ${stamp.slice(0, 10)} · takeover · ${claimant} took over from ${cur.fm.claimed_by} (claim stale since ${since})`);
      }
      writeFileSync(cur.file, text);
      return [relPath(slug)];
    },
    validate: (c) => readFm(c, slug)?.fm.claimed_by === claimant,
  });
  if (r.ok) return { ok: true, takeover: old };
  if (r.reason === 'nothing-to-do' && refusal) return { ok: false, reason: refusal };
  return { ok: false, reason: r.reason };
}

export async function renew(clone, slug, { claimant, identity, workerId, now, hooks }) {
  // renew commits are allowed to be empty, so refuse before boardWrite rather than inside mutate.
  sync(clone);
  if (!holds(clone, slug, claimant)) return { ok: false, reason: 'replaced' };
  return boardWrite(clone, {
    kind: 'renew', subject: slug, identity, onReject: 'rebase', hooks,
    trailers: trailersFor(slug, workerId),
    mutate: (c) => {
      const cur = readFm(c, slug);
      if (!cur) return [];
      writeFileSync(cur.file, setFields(cur.text, { renewed_at: iso(now) }));
      return [relPath(slug)];
    },
    validate: (c) => holds(c, slug, claimant),
  });
}

export async function release(clone, slug, { claimant, identity, workerId, extraMutate, hooks }) {
  return boardWrite(clone, {
    kind: 'release', subject: slug, identity, onReject: 'rebase', hooks,
    trailers: trailersFor(slug, workerId),
    mutate: (c) => {
      const cur = readFm(c, slug);
      const paths = [];
      if (cur && cur.fm.claimed_by === claimant) {
        writeFileSync(cur.file, setFields(cur.text, Object.fromEntries(CLAIM_FIELDS.map((k) => [k, null]))));
        paths.push(relPath(slug));
      }
      if (extraMutate) paths.push(...extraMutate(c));
      return paths;
    },
    validate: (c) => {
      const cur = readFm(c, slug);
      return !cur || CLAIM_FIELDS.every((k) => cur.fm[k] == null);
    },
  });
}
