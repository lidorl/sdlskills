import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeBoard, IDENT } from './fixtures.mjs';
import { claimState, claim, renew, release, holds } from './claims.mjs';
import { parseDoc } from './frontmatter.mjs';

const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const NOW = new Date('2026-11-20T12:00:00.000Z');
const TTL = 4 * 3600e3;
const noSleep = () => Promise.resolve();
const base = { identity: IDENT, now: NOW, ttlMs: TTL, isAwaitingOpen: () => false, sleep: noSleep };
const rel = (slug) => `docs/feat-req/${slug}.md`;

function setup(fm = { title: 'Bulk export', status: 'APPROVED' }) {
  const fx = makeBoard({ featReqs: { 'bulk-export': fm } });
  const fmOnRemote = (slug = 'bulk-export') => {
    const t = g(fx.clone(`peek-${Math.random().toString(36).slice(2)}`), 'show', 'origin/main:' + rel(slug));
    return parseDoc(t).data;
  };
  return { fx, fmOnRemote };
}

test('claimState: unclaimed / live / stale / future renewed_at is live', () => {
  assert.equal(claimState({}, NOW, TTL), 'unclaimed');
  assert.equal(claimState({ claimed_by: 'x', claimed_at: '2026-11-20T10:00:00Z' }, NOW, TTL), 'live');
  assert.equal(claimState({ claimed_by: 'x', claimed_at: '2026-11-20T10:00:00Z', renewed_at: '2026-11-20T07:00:00Z' }, NOW, TTL), 'stale');
  assert.equal(claimState({ claimed_by: 'x', renewed_at: '2026-11-20T12:00:00Z' }, new Date('2026-11-20T11:00:00Z'), TTL), 'live');
});

test('claim writes the three fields as ISO seconds and a claim commit', async () => {
  const { fx, fmOnRemote } = setup();
  const a = fx.clone('a');
  const r = await claim(a, 'bulk-export', { ...base, claimant: 'a-worker1', workerId: 'a-worker1' });
  assert.deepEqual(r, { ok: true, takeover: null });
  const fm = fmOnRemote();
  assert.equal(fm.claimed_by, 'a-worker1');
  assert.equal(fm.claimed_at, '2026-11-20T12:00:00Z');
  assert.equal(fm.renewed_at, '2026-11-20T12:00:00Z');
  const msg = g(a, 'log', '-1', '--format=%B');
  assert.match(msg, /^board\(claim\): bulk-export/);
  assert.match(msg, /Worker: a-worker1/);
  assert.match(msg, /Effort: bulk-export/);
  assert.equal(holds(a, 'bulk-export', 'a-worker1'), true);
});

test('race: two clones claim the same effort, exactly one holds it on origin/main', async () => {
  const { fx, fmOnRemote } = setup();
  const a = fx.clone('a'); const b = fx.clone('b');
  let pB;
  const rA = await claim(a, 'bulk-export', {
    ...base, claimant: 'a-worker1', workerId: 'a-worker1',
    // B's claim runs its whole git sequence synchronously inside A's push window.
    hooks: { beforePush: () => { pB = claim(b, 'bulk-export', { ...base, claimant: 'b-worker1', workerId: 'b-worker1' }); } },
  });
  const rB = await pB;
  assert.equal(rA.ok, false); assert.equal(rA.reason, 'lost-race');
  assert.equal(rB.ok, true);
  assert.equal(fmOnRemote().claimed_by, 'b-worker1');
  assert.equal(holds(a, 'bulk-export', 'a-worker1'), false);
  assert.equal(g(a, 'rev-parse', 'HEAD'), g(a, 'rev-parse', 'origin/main'));
});

test('live claim by someone else is held; awaiting open is awaiting; missing file is gone', async () => {
  const { fx } = setup({ title: 't', claimed_by: 'x', claimed_at: '2026-11-20T11:00:00Z', renewed_at: '2026-11-20T11:30:00Z' });
  fx.seed(rel('waiting'), '---\nawaiting: question-1\n---\n\n# w\n');
  const a = fx.clone('a');
  assert.deepEqual(await claim(a, 'bulk-export', { ...base, claimant: 'a-w' }), { ok: false, reason: 'held' });
  assert.deepEqual(await claim(a, 'waiting', { ...base, claimant: 'a-w', isAwaitingOpen: () => true }), { ok: false, reason: 'awaiting' });
  assert.equal((await claim(a, 'waiting', { ...base, claimant: 'a-w', isAwaitingOpen: () => false })).ok, true);
  assert.deepEqual(await claim(a, 'nope', { ...base, claimant: 'a-w' }), { ok: false, reason: 'gone' });
  assert.equal(g(a, 'rev-parse', 'HEAD'), g(a, 'rev-parse', 'origin/main'));
});

test('stale claim -> takeover with Replaces trailer and a ## Decisions line', async () => {
  const { fx, fmOnRemote } = setup({ title: 't', claimed_by: 'old-w', claimed_at: '2026-11-20T01:00:00Z', renewed_at: '2026-11-20T02:00:00Z' });
  const a = fx.clone('a');
  const r = await claim(a, 'bulk-export', { ...base, claimant: 'a-w', workerId: 'a-w' });
  assert.deepEqual(r, { ok: true, takeover: 'old-w' });
  assert.equal(fmOnRemote().claimed_by, 'a-w');
  const msg = g(a, 'log', '-1', '--format=%B');
  assert.match(msg, /^board\(takeover\): bulk-export/);
  assert.match(msg, /Replaces: old-w/);
  const body = readFileSync(join(a, rel('bulk-export')), 'utf8');
  assert.match(body, /## Decisions\n[\s\S]*- 2026-11-20 · takeover · a-w took over from old-w \(claim stale since 2026-11-20T02:00:00Z\)/);
});

// Raw-git edit pushed by clone `b` (a stand-in for another actor racing our write).
function racerEdit(b, slug, edit) {
  let done = false;
  return () => {
    if (done) return; // boardWrite calls beforePush again on every rebase retry
    done = true;
    const f = join(b, rel(slug));
    writeFileSync(f, edit(readFileSync(f, 'utf8')));
    g(b, 'commit', '-am', 'racer'); g(b, 'push', 'origin', 'main');
  };
}
const SPREAD = { claimed_by: 'a-w', claimed_at: '2026-11-20T11:00:00Z', title: 't', status: 'APPROVED', p: 1, q: 2, r: 3, renewed_at: '2026-11-20T11:30:00Z' };

test('rebase conflict on claim fields is never resolved in our favour', async () => {
  const { fx, fmOnRemote } = setup(SPREAD);
  const a = fx.clone('a'); const b = fx.clone('b');
  const r = await release(a, 'bulk-export', {
    ...base, claimant: 'a-w',
    hooks: { beforePush: racerEdit(b, 'bulk-export', (t) => t.replace(/renewed_at: .*/, 'renewed_at: 2026-11-20T11:59:00Z')) },
  });
  assert.deepEqual(r, { ok: false, reason: 'conflict' });
  assert.equal(fmOnRemote().claimed_by, 'a-w');
  assert.equal(fmOnRemote().renewed_at, '2026-11-20T11:59:00Z');
  assert.equal(g(a, 'rev-parse', 'HEAD'), g(a, 'rev-parse', 'origin/main'));
});

test('claim replaced between push and validate -> replaced, holds() false', async () => {
  const { fx, fmOnRemote } = setup(SPREAD);
  const a = fx.clone('a'); const b = fx.clone('b');
  const r = await renew(a, 'bulk-export', {
    ...base, claimant: 'a-w',
    hooks: { beforePush: racerEdit(b, 'bulk-export', (t) => t.replace(/claimed_by: .*\n/, 'claimed_by: b-w\n')) },
  });
  assert.deepEqual(r, { ok: false, reason: 'replaced' });
  assert.equal(fmOnRemote().claimed_by, 'b-w');
  assert.equal(holds(a, 'bulk-export', 'a-w'), false);
});

test('renew by a non-holder fails replaced and writes no commit', async () => {
  const { fx } = setup(SPREAD);
  const a = fx.clone('a');
  const before = g(a, 'rev-parse', 'origin/main');
  assert.deepEqual(await renew(a, 'bulk-export', { ...base, claimant: 'zzz' }), { ok: false, reason: 'replaced' });
  assert.equal(g(a, 'rev-parse', 'origin/main'), before);
});

test('holds() is false once a person parks or deletes the feat-req', async () => {
  const { fx } = setup(SPREAD);
  const a = fx.clone('a');
  assert.equal(holds(a, 'bulk-export', 'a-w'), true);
  assert.equal(holds(a, 'bulk-export', 'other'), false);
  fx.seed(rel('bulk-export'), '---\nclaimed_by: a-w\nstatus: PARKED\n---\n\n# x\n');
  g(a, 'pull', '--ff-only', 'origin', 'main');
  assert.equal(holds(a, 'bulk-export', 'a-w'), false);
  g(a, 'rm', '-q', rel('bulk-export'));
  assert.equal(holds(a, 'bulk-export', 'a-w'), false);
});

test('release clears claimed_by/claimed_at/renewed_at, leaves other fields, and carries extraMutate', async () => {
  const { fx, fmOnRemote } = setup(SPREAD);
  const a = fx.clone('a');
  const r = await release(a, 'bulk-export', {
    ...base, claimant: 'a-w', workerId: 'a-w',
    extraMutate: (c) => { writeFileSync(join(c, 'board/requests/x.md'), 'req\n'); return ['board/requests/x.md']; },
  });
  assert.equal(r.ok, true);
  const fm = fmOnRemote();
  assert.deepEqual(fm, { title: 't', status: 'APPROVED', p: 1, q: 2, r: 3 });
  assert.equal(g(a, 'show', 'origin/main:board/requests/x.md'), 'req');
  assert.match(g(a, 'log', '-1', '--format=%B'), /^board\(release\): bulk-export/);
});

test('renew touches only renewed_at', async () => {
  const { fx, fmOnRemote } = setup(SPREAD);
  const a = fx.clone('a');
  const r = await renew(a, 'bulk-export', { ...base, claimant: 'a-w', workerId: 'a-w' });
  assert.equal(r.ok, true);
  assert.deepEqual(fmOnRemote(), { ...SPREAD, renewed_at: '2026-11-20T12:00:00Z' });
  assert.match(g(a, 'log', '-1', '--format=%B'), /^board\(renew\)/);
});
