// Worker registry (durable identity in board/workers/<id>.yml) and worker state derived from events,
// claims and requests. boardView feeds `sdlc status`, `sdlc inbox` and render-status.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { stringify, parse } from 'yaml';
import { safePath, WORKER_ID_RE } from './safe-path.mjs';
import { parseLog } from './events.mjs';
import { claimState } from './claims.mjs';
import { listRequests } from './requests.mjs';
import { loadEfforts } from './queue.mjs';

export function workerYaml({ id, owner, name, host, agent, model, created_at, retired_at = null }) {
  return stringify({ id, owner, name, host, agent, model, created_at, retired_at }, { lineWidth: 0 });
}

export function readWorker(root, id) {
  if (!WORKER_ID_RE.test(String(id))) return null;
  try {
    const file = safePath(root, `board/workers/${id}.yml`);
    if (!existsSync(file)) return null;
    const w = parse(readFileSync(file, 'utf8'));
    return w && typeof w === 'object' ? w : null;
  } catch {
    return null;
  }
}

export function listWorkers(root) {
  let dir;
  try { dir = safePath(root, 'board/workers'); } catch { return []; }
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith('.yml') && WORKER_ID_RE.test(n.slice(0, -4)))
    .sort()
    .map((n) => readWorker(root, n.slice(0, -4)))
    .filter(Boolean);
}

const time = (v) => { const t = new Date(v).getTime(); return Number.isNaN(t) ? 0 : t; };
const sinceOf = (fm) => time(fm.renewed_at ?? fm.claimed_at);

export function workerState(id, { worker, events, efforts, requests, now, ttlMs }) {
  const mine = events.filter((e) => e.worker === id);
  const newest = (list) => list.reduce((a, e) => (!a || e.at > a.at ? e : a), null);
  const lastSeen = newest(mine)?.at ?? null;
  const out = (state, effort = null) => ({ state, effort, lastSeen });

  if (worker?.retired_at) return out('retired');
  if (requests.some((r) => r.fm.kind === 'error' && r.fm.scope === 'worker' && r.fm.status === 'open' && r.fm.worker === id)) {
    return out('needs-attention');
  }
  const life = newest(mine.filter((e) => ['start', 'stop', 'crash'].includes(e.kind)));
  if (life?.kind !== 'start') return out('stopped');

  const held = efforts.filter((e) => e.fm?.claimed_by === id);
  const latest = (state) => held
    .filter((e) => claimState(e.fm, now, ttlMs) === state)
    .sort((a, b) => sinceOf(b.fm) - sinceOf(a.fm) || time(b.fm.claimed_at) - time(a.fm.claimed_at))[0];
  const live = latest('live');
  if (live) return out('working', live.slug);
  const stale = latest('stale');
  if (stale) return out('stale', stale.slug);
  return out('idle');
}

export function boardView(root, { now, ttlMs, events } = {}) {
  let evs = events;
  if (!evs) {
    try { evs = parseLog(root, { ref: 'HEAD' }); } catch { evs = []; }
  }
  const { efforts } = loadEfforts(root);
  const { requests } = listRequests(root);

  const workers = listWorkers(root).map((w) => ({
    ...w, ...workerState(w.id, { worker: w, events: evs, efforts, requests, now, ttlMs }),
  }));

  const inbox = {};
  for (const r of requests.filter((r) => r.fm.status === 'open')) (inbox[r.fm.for] ??= []).push(r);
  for (const list of Object.values(inbox)) list.sort((a, b) => time(a.fm.created_at) - time(b.fm.created_at));

  const inFlight = efforts.filter((e) => e.fm?.claimed_by).map((e) => ({
    slug: e.slug,
    status: e.status,
    claimant: e.fm.claimed_by,
    claimAgeMs: Math.max(0, now.getTime() - sinceOf(e.fm)),
    stale: claimState(e.fm, now, ttlMs) === 'stale',
  }));
  return { workers, inbox, inFlight };
}
