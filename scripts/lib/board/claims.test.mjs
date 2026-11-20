import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeBoard, IDENT } from './fixtures.mjs';
import { BoardError } from './git.mjs';
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
  const fmOnRemote = (slug = 'bulk-export') => parseDoc(g(fx.remote, 'show', 'main:' + rel(slug))).data;
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
    // A awaits B's whole claim inside its push window, so B always lands first.
    hooks: { beforePush: () => (pB ??= claim(b, 'bulk-export', { ...base, claimant: 'b-worker1', workerId: 'b-worker1' })) },
  });
  const rB = await pB;
  assert.equal(rA.ok, false); assert.equal(rA.reason, 'lost-race');
  assert.equal(rB.ok, true);
  assert.equal(fmOnRemote().claimed_by, 'b-worker1');
  assert.equal(holds(a, 'bulk-export', 'a-worker1'), false);
  assert.equal(g(a, 'rev-parse', 'HEAD'), g(a, 'rev-parse', 'origin/main'));
});

test('live claim by someone else is held; awaiting open is awaiting; missing file is gone', async () => {
  const fx = makeBoard({
    featReqs: { 'bulk-export': { title: 't', claimed_by: 'x', claimed_at: '2026-11-20T11:00:00Z', renewed_at: '2026-11-20T11:30:00Z' } },
    files: { [rel('waiting')]: '---\nawaiting: question-1\n---\n\n# w\n' },
  });
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

test('release restarts when raced and never clears a claim someone else took', async () => {
  const { fx, fmOnRemote } = setup(SPREAD);
  const a = fx.clone('a'); const b = fx.clone('b');
  const r = await release(a, 'bulk-export', {
    ...base, claimant: 'a-w',
    hooks: { beforePush: racerEdit(b, 'bulk-export', (t) => t.replace(/claimed_by: .*\n/, 'claimed_by: b-w\n')) },
  });
  assert.deepEqual(r, { ok: false, reason: 'replaced' });
  assert.equal(fmOnRemote().claimed_by, 'b-w');
  assert.equal(fmOnRemote().renewed_at, '2026-11-20T11:30:00Z');
  assert.equal(g(a, 'rev-parse', 'HEAD'), g(a, 'rev-parse', 'origin/main'));
});

test('release retries after a non-conflicting race while we still hold', async () => {
  const { fx, fmOnRemote } = setup(SPREAD);
  const a = fx.clone('a'); const b = fx.clone('b');
  const r = await release(a, 'bulk-export', {
    ...base, claimant: 'a-w',
    hooks: { beforePush: racerEdit(b, 'bulk-export', (t) => t.replace(/renewed_at: .*/, 'renewed_at: 2026-11-20T11:59:00Z')) },
  });
  assert.equal(r.ok, true);
  assert.equal(fmOnRemote().claimed_by, undefined);
});

test('renew raced by a takeover does not write onto the new claim', async () => {
  const { fx, fmOnRemote } = setup(SPREAD);
  const a = fx.clone('a'); const b = fx.clone('b');
  const r = await renew(a, 'bulk-export', {
    ...base, claimant: 'a-w',
    hooks: { beforePush: racerEdit(b, 'bulk-export', (t) => t.replace(/claimed_by: .*\n/, 'claimed_by: b-w\n')) },
  });
  assert.deepEqual(r, { ok: false, reason: 'replaced' });
  assert.equal(fmOnRemote().claimed_by, 'b-w');
  assert.equal(fmOnRemote().renewed_at, '2026-11-20T11:30:00Z');
  assert.equal(holds(a, 'bulk-export', 'a-w'), false);
});

test('renew after the file is deleted is replaced and pushes nothing', async () => {
  const { fx } = setup(SPREAD);
  const a = fx.clone('a'); const b = fx.clone('b');
  g(b, 'rm', '-q', rel('bulk-export')); g(b, 'commit', '-qm', 'rm'); g(b, 'push', '-q', 'origin', 'main');
  const before = g(b, 'rev-parse', 'HEAD');
  assert.deepEqual(await renew(a, 'bulk-export', { ...base, claimant: 'a-w' }), { ok: false, reason: 'replaced' });
  g(a, 'fetch', '-q', 'origin', 'main');
  assert.equal(g(a, 'rev-parse', 'origin/main'), before);
});

test('release and renew work on a clone with no git identity and a dirty tree', async () => {
  const { fx } = setup(SPREAD);
  const a = fx.clone('a'); const b = fx.clone('b');
  execFileSync('git', ['config', '--unset', 'user.name'], { cwd: a });
  execFileSync('git', ['config', '--unset', 'user.email'], { cwd: a });
  writeFileSync(join(a, 'README.md'), 'dirty\n');
  writeFileSync(join(b, 'other.md'), 'x\n'); g(b, 'add', '.'); g(b, 'commit', '-qm', 'o'); g(b, 'push', '-q', 'origin', 'main');
  assert.equal((await renew(a, 'bulk-export', { ...base, claimant: 'a-w' })).ok, true);
});

test('takeover decision changes between peek and write: record matches the state (stale -> unclaimed)', async () => {
  const { fx, fmOnRemote } = setup({ title: 't', claimed_by: 'old-w', claimed_at: '2026-11-20T01:00:00Z', renewed_at: '2026-11-20T02:00:00Z' });
  const a = fx.clone('a'); const b = fx.clone('b');
  let done = false;
  const afterPeek = () => {
    if (done) return; done = true;
    const f = join(b, rel('bulk-export'));
    writeFileSync(f, readFileSync(f, 'utf8').replace(/claimed_by: .*\n/, '').replace(/claimed_at: .*\n/, '').replace(/renewed_at: .*\n/, ''));
    g(b, 'commit', '-qam', 'released'); g(b, 'push', '-q', 'origin', 'main');
  };
  const r = await claim(a, 'bulk-export', { ...base, claimant: 'a-w', hooks: { afterPeek } });
  assert.deepEqual(r, { ok: true, takeover: null });
  const msg = g(a, 'log', '-1', '--format=%B');
  assert.match(msg, /^board\(claim\): bulk-export/);
  assert.doesNotMatch(msg, /Replaces/);
  assert.doesNotMatch(readFileSync(join(a, rel('bulk-export')), 'utf8'), /takeover/);
  assert.equal(fmOnRemote().claimed_by, 'a-w');
});

test('takeover decision changes between peek and write: stale X -> stale Y uses Y everywhere', async () => {
  const { fx } = setup({ title: 't', claimed_by: 'x-w', claimed_at: '2026-11-20T01:00:00Z', renewed_at: '2026-11-20T02:00:00Z' });
  const a = fx.clone('a'); const b = fx.clone('b');
  let done = false;
  const afterPeek = () => {
    if (done) return; done = true;
    const f = join(b, rel('bulk-export'));
    writeFileSync(f, readFileSync(f, 'utf8').replace('x-w', 'y-w'));
    g(b, 'commit', '-qam', 'y'); g(b, 'push', '-q', 'origin', 'main');
  };
  const r = await claim(a, 'bulk-export', { ...base, claimant: 'a-w', hooks: { afterPeek } });
  assert.deepEqual(r, { ok: true, takeover: 'y-w' });
  assert.match(g(a, 'log', '-1', '--format=%B'), /Replaces: y-w/);
  assert.match(readFileSync(join(a, rel('bulk-export')), 'utf8'), /took over from y-w/);
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

test('claim refuses a PARKED, REJECTED or IMPLEMENTED effort as closed and pushes nothing', async () => {
  for (const status of ['PARKED', 'REJECTED', 'IMPLEMENTED']) {
    const { fx } = setup({ title: 't', status });
    const a = fx.clone('a');
    const before = g(fx.remote, 'rev-parse', 'main');
    assert.deepEqual(await claim(a, 'bulk-export', { ...base, claimant: 'a-w' }), { ok: false, reason: 'closed' }, status);
    assert.equal(g(fx.remote, 'rev-parse', 'main'), before);
  }
});

test('renew of a claim whose effort is now IMPLEMENTED is replaced and pushes nothing', async () => {
  const { fx } = setup({ ...SPREAD, status: 'IMPLEMENTED' });
  const a = fx.clone('a');
  const before = g(fx.remote, 'rev-parse', 'main');
  assert.deepEqual(await renew(a, 'bulk-export', { ...base, claimant: 'a-w' }), { ok: false, reason: 'replaced' });
  assert.equal(g(fx.remote, 'rev-parse', 'main'), before);
});

test('re-claiming your own live claim renews it: ok, no takeover, renewed_at refreshed', async () => {
  const { fx, fmOnRemote } = setup(SPREAD);
  const a = fx.clone('a');
  const r = await claim(a, 'bulk-export', { ...base, claimant: 'a-w', workerId: 'a-w' });
  assert.deepEqual(r, { ok: true, takeover: null });
  assert.equal(fmOnRemote().claimed_by, 'a-w');
  assert.equal(fmOnRemote().claimed_at, SPREAD.claimed_at);
  assert.equal(fmOnRemote().renewed_at, '2026-11-20T12:00:00Z');
  assert.match(g(a, 'log', '-1', '--format=%B'), /^board\(renew\): bulk-export/);
});

test('a committed symlinked feat-req is refused by claim; the outside file is untouched', async () => {
  const fx = makeBoard();
  const outside = join(mkdtempSync(join(tmpdir(), 'outside-')), 'target.md');
  writeFileSync(outside, '---\nstatus: ACCEPTED\n---\n# outside\n');
  const pusher = fx.clone('pusher');
  mkdirSync(join(pusher, 'docs/feat-req'), { recursive: true });
  symlinkSync(outside, join(pusher, rel('evil')));
  g(pusher, 'add', '-A'); g(pusher, 'commit', '-qm', 'symlink'); g(pusher, 'push', '-q', 'origin', 'main');
  const a = fx.clone('a');
  const before = g(fx.remote, 'rev-parse', 'main');
  await assert.rejects(claim(a, 'evil', { ...base, claimant: 'a-w' }), /symlink/);
  assert.equal(readFileSync(outside, 'utf8'), '---\nstatus: ACCEPTED\n---\n# outside\n');
  assert.equal(g(fx.remote, 'rev-parse', 'main'), before);
  assert.equal(g(a, 'status', '--porcelain'), '');
});

test('claim, renew and release refuse an invalid slug before touching anything', async () => {
  const { fx } = setup();
  const a = fx.clone('a');
  for (const slug of ['../etc/passwd', 'Bulk', '', 'a/b']) {
    await assert.rejects(claim(a, slug, { ...base, claimant: 'a-w' }), (e) => e instanceof BoardError && /invalid slug/.test(e.message), slug);
    await assert.rejects(renew(a, slug, { ...base, claimant: 'a-w' }), BoardError, slug);
    await assert.rejects(release(a, slug, { ...base, claimant: 'a-w' }), BoardError, slug);
  }
});

test('renew does not publish an uncommitted edit to the feat-req; the edit survives locally', async () => {
  const { fx } = setup(SPREAD);
  const a = fx.clone('a');
  const f = join(a, rel('bulk-export'));
  writeFileSync(f, `${readFileSync(f, 'utf8')}\nMy local draft note.\n`);
  const r = await renew(a, 'bulk-export', { ...base, claimant: 'a-w' });
  assert.equal(r.ok, true);
  const onMain = g(fx.remote, 'show', 'main:' + rel('bulk-export'));
  assert.doesNotMatch(onMain, /local draft/);
  assert.equal(parseDoc(onMain).data.renewed_at, '2026-11-20T12:00:00Z');
  const local = readFileSync(f, 'utf8');
  assert.match(local, /My local draft note\./);
  assert.equal(parseDoc(local).data.renewed_at, '2026-11-20T12:00:00Z', 'the person keeps the new lease too');
});

test('a person\'s conflicting uncommitted frontmatter edit is left exactly as it was', async () => {
  const { fx } = setup(SPREAD);
  const a = fx.clone('a');
  const f = join(a, rel('bulk-export'));
  const mine = readFileSync(f, 'utf8').replace(/renewed_at: .*/, 'renewed_at: 2030-01-01T00:00:00Z');
  writeFileSync(f, mine);
  assert.equal((await renew(a, 'bulk-export', { ...base, claimant: 'a-w' })).ok, true);
  assert.equal(parseDoc(g(fx.remote, 'show', 'main:' + rel('bulk-export'))).data.renewed_at, '2026-11-20T12:00:00Z');
  assert.equal(readFileSync(f, 'utf8'), mine);
});

test('a mutate that throws leaves no half-written protocol files: the next renew still sees the claim', async () => {
  const { fx, fmOnRemote } = setup(SPREAD);
  const a = fx.clone('a');
  await assert.rejects(release(a, 'bulk-export', {
    ...base, claimant: 'a-w',
    extraMutate: (c) => { writeFileSync(join(c, 'board/requests/202611201200-aaaaaa.md'), 'half\n'); throw new Error('boom'); },
  }), /boom/);
  assert.equal(g(a, 'status', '--porcelain'), '');
  assert.equal(parseDoc(readFileSync(join(a, rel('bulk-export')), 'utf8')).data.claimed_by, 'a-w');
  assert.equal((await renew(a, 'bulk-export', { ...base, claimant: 'a-w' })).ok, true);
  assert.equal(fmOnRemote().claimed_by, 'a-w');
});
