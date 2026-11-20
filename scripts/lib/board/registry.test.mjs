import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workerYaml, readWorker, listWorkers, workerState, boardView } from './registry.mjs';

const NOW = new Date('2026-11-20T12:00:00Z');
const TTL = 4 * 3600e3;
const ID = 'lidor-abc123';
const base = { id: ID, owner: 'lidor', name: 'w1', host: 'mac', agent: 'claude-code', model: 'opus', created_at: '2026-11-01T00:00:00Z' };
const ev = (kind, at, worker = ID) => ({ kind, worker, at: new Date(at) });
const effort = (slug, fm) => ({ slug, status: 'IN_PROGRESS', fm });
const req = (id, fm) => ({ id, fm: { id, status: 'open', ...fm } });
const st = (o) => workerState(ID, { worker: base, events: [], efforts: [], requests: [], now: NOW, ttlMs: TTL, ...o });
const started = [ev('start', '2026-11-20T09:00:00Z')];

function tmpRoot() {
  const root = mkdtempSync(join(tmpdir(), 'registry-'));
  mkdirSync(join(root, 'board/workers'), { recursive: true });
  return root;
}

test('workerYaml: fixed key order, retired_at null by default', () => {
  const y = workerYaml(base);
  assert.deepEqual(y.split('\n').filter(Boolean).map((l) => l.split(':')[0]),
    ['id', 'owner', 'name', 'host', 'agent', 'model', 'created_at', 'retired_at']);
  assert.match(y, /retired_at: null/);
});

test('readWorker / listWorkers round trip; invalid ids and symlinks are refused', () => {
  const root = tmpRoot();
  writeFileSync(join(root, `board/workers/${ID}.yml`), workerYaml(base));
  writeFileSync(join(root, 'board/workers/other-zzz999.yml'), workerYaml({ ...base, id: 'other-zzz999' }));
  writeFileSync(join(root, 'board/workers/notes.yml'), 'x: 1\n');
  assert.equal(readWorker(root, ID).name, 'w1');
  assert.equal(readWorker(root, 'missing-abc123'), null);
  assert.equal(readWorker(root, '../../etc/passwd'), null);
  assert.equal(readWorker(root, 'Bad Id'), null);
  assert.deepEqual(listWorkers(root).map((w) => w.id), [ID, 'other-zzz999']);
  assert.deepEqual(listWorkers(mkdtempSync(join(tmpdir(), 'registry-'))), []);
  const outside = mkdtempSync(join(tmpdir(), 'registry-out-'));
  writeFileSync(join(outside, 'f.yml'), workerYaml({ ...base, id: 'evil-abc123' }));
  symlinkSync(join(outside, 'f.yml'), join(root, 'board/workers/evil-abc123.yml'));
  assert.equal(readWorker(root, 'evil-abc123'), null);
});

test('retired wins over everything', () => {
  const r = st({ worker: { ...base, retired_at: '2026-11-10T00:00:00Z' }, events: started,
    requests: [req('r1', { kind: 'error', scope: 'worker', worker: ID })] });
  assert.equal(r.state, 'retired');
});

test('needs-attention: open worker-scope error naming it (answered, other scope, other worker do not count)', () => {
  const e = { kind: 'error', scope: 'worker', worker: ID };
  assert.equal(st({ events: started, requests: [req('r1', e)] }).state, 'needs-attention');
  assert.notEqual(st({ events: started, requests: [req('r1', { ...e, status: 'answered' })] }).state, 'needs-attention');
  assert.notEqual(st({ events: started, requests: [req('r1', { ...e, scope: 'effort' })] }).state, 'needs-attention');
  assert.notEqual(st({ events: started, requests: [req('r1', { ...e, worker: 'x-aaaaaa' })] }).state, 'needs-attention');
});

test('stopped: last of start/stop/crash is not start; none at all is stopped', () => {
  assert.equal(st({ events: [ev('stop', '2026-11-20T10:00:00Z'), ...started] }).state, 'stopped');
  assert.equal(st({ events: [ev('crash', '2026-11-20T10:00:00Z'), ...started] }).state, 'stopped');
  assert.equal(st({ events: [] }).state, 'stopped');
  assert.equal(st({ events: [ev('claim', '2026-11-20T10:00:00Z'), ...started] }).state, 'idle');
});

test('working: holds a live claim; the most recent live one is reported', () => {
  const efforts = [
    effort('a', { claimed_by: ID, claimed_at: '2026-11-20T10:00:00Z' }),
    effort('b', { claimed_by: ID, claimed_at: '2026-11-20T11:00:00Z' }),
    effort('c', { claimed_by: 'x-aaaaaa', claimed_at: '2026-11-20T11:30:00Z' }),
  ];
  const r = st({ events: started, efforts });
  assert.equal(r.state, 'working');
  assert.equal(r.effort, 'b');
});

test('stale: only a stale claim held; lastSeen is the newest event of the worker', () => {
  const efforts = [effort('a', { claimed_by: ID, claimed_at: '2026-11-19T00:00:00Z' })];
  const events = [ev('renew', '2026-11-20T09:30:00Z', 'other-aaaaaa'), ev('claim', '2026-11-20T09:10:00Z'), ...started];
  const r = st({ events, efforts });
  assert.equal(r.state, 'stale');
  assert.equal(r.effort, 'a');
  assert.deepEqual(r.lastSeen, new Date('2026-11-20T09:10:00Z'));
});

test('idle: started, holds nothing; lastSeen null with no events by it', () => {
  assert.deepEqual(st({ events: started }).effort, null);
  assert.equal(st({ events: started }).state, 'idle');
  assert.equal(st({ events: [] }).lastSeen, null);
});

test('boardView: workers with state, inbox grouped by for oldest first, inFlight rows', () => {
  const root = tmpRoot();
  writeFileSync(join(root, `board/workers/${ID}.yml`), workerYaml(base));
  mkdirSync(join(root, 'board/requests'), { recursive: true });
  mkdirSync(join(root, 'docs/feat-req'), { recursive: true });
  const mkReq = (id, forWho, created, status = 'open') => writeFileSync(join(root, `board/requests/${id}.md`),
    `---\nid: ${id}\nkind: clarification\nscope: effort\nstatus: ${status}\nfor: ${forWho}\ncreated_at: ${created}\n---\n\n## Answer\n`);
  mkReq('202611201100-aaaaaa', 'lidor', '2026-11-20T11:00:00Z');
  mkReq('202611201000-bbbbbb', 'lidor', '2026-11-20T10:00:00Z');
  mkReq('202611200900-cccccc', 'dana', '2026-11-20T09:00:00Z');
  mkReq('202611200800-dddddd', 'dana', '2026-11-20T08:00:00Z', 'answered');
  const feat = (slug, extra) => writeFileSync(join(root, `docs/feat-req/${slug}.md`), `---\nstatus: IN_PROGRESS\n${extra}---\n\n# ${slug}\n`);
  feat('live-one', `claimed_by: ${ID}\nclaimed_at: 2026-11-20T10:00:00Z\nrenewed_at: 2026-11-20T11:00:00Z\n`);
  feat('old-one', `claimed_by: dana-bbbbbb\nclaimed_at: 2026-11-19T00:00:00Z\n`);
  feat('free-one', '');
  const v = boardView(root, { now: NOW, ttlMs: TTL, events: started });
  assert.equal(v.workers.length, 1);
  assert.equal(v.workers[0].state, 'working');
  assert.equal(v.workers[0].effort, 'live-one');
  assert.deepEqual(Object.keys(v.inbox).sort(), ['dana', 'lidor']);
  assert.deepEqual(v.inbox.lidor.map((r) => r.id), ['202611201000-bbbbbb', '202611201100-aaaaaa']);
  assert.deepEqual(v.inbox.dana.map((r) => r.id), ['202611200900-cccccc']);
  const by = Object.fromEntries(v.inFlight.map((r) => [r.slug, r]));
  assert.deepEqual(Object.keys(by).sort(), ['live-one', 'old-one']);
  assert.equal(by['live-one'].claimant, ID);
  assert.equal(by['live-one'].claimAgeMs, 3600e3);
  assert.equal(by['live-one'].stale, false);
  assert.equal(by['old-one'].stale, true);
  assert.equal(by['old-one'].status, 'IN_PROGRESS');
});

test('boardView without events and without git history does not throw', () => {
  const root = tmpRoot();
  const v = boardView(root, { now: NOW, ttlMs: TTL });
  assert.deepEqual(v, { workers: [], inbox: {}, inFlight: [] });
});
