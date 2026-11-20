import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, symlinkSync, mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { stringify } from 'yaml';
import { makeBoard, IDENT } from './fixtures.mjs';
import { applyAnswer, applyAnswered, applyClosed } from './effects.mjs';
import { buildRequest, listRequests } from './requests.mjs';
import { parseDoc, setFields } from './frontmatter.mjs';
import { claim } from './claims.mjs';

const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const NOW = new Date('2026-11-20T12:00:00.000Z');
const WHO = 'a-worker1';
const SLUG = 'bulk-export';
const ctx = { now: NOW, claimant: WHO };

let seq = 0;
function answered({ kind, gate = null, scope = 'effort', effort = SLUG, sections = {}, answer, notes = '' }) {
  const id = `2026112010${String(seq++).padStart(2, '0')}-abcde${seq % 10}`;
  const base = buildRequest({
    id, kind, gate, scope, effort, phase: null, worker: 'w-111111', for: 'owner', blocking: true, now: NOW,
    sections: { Request: 'Req', Context: 'Ctx', ...sections },
  });
  let text = setFields(base, { status: 'answered', answer, answered_by: 'owner', answered_at: '2026-11-20T11:00:00Z', answered_via: 'cli' });
  text = text.replace(/## Answer\n*$/, `## Answer\n\n${notes}\n`);
  return { id, text };
}

const DEFAULT_FM = { title: 'Bulk export', status: 'ACCEPTED' };
const requestFiles = (reqs) => Object.fromEntries(reqs.map((r) => [`board/requests/${r.id}.md`, r.text]));

function setup({ fm = DEFAULT_FM, files = {}, reqs = [] } = {}) {
  return makeBoard({ featReqs: { [SLUG]: fm }, files: { ...files, ...requestFiles(reqs) } });
}

// applyAnswer is pure file work: a plain directory, no git.
function plainTree({ fm = DEFAULT_FM, files = {}, reqs = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'effects-'));
  const all = { [`docs/feat-req/${SLUG}.md`]: `---\n${stringify(fm)}---\n\n# ${SLUG}\n`, ...files, ...requestFiles(reqs) };
  for (const [f, c] of Object.entries(all)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), c);
  }
  return root;
}

const read = (root, f) => readFileSync(join(root, f), 'utf8');
const fmOf = (root, f) => parseDoc(read(root, f)).data;
const DESIGN = '---\nstatus: DRAFT\n---\n\n# Design\n';
const PLAN = '---\nstatus: PLANNED\n---\n\n# Plan\n\n- [x] one\n- [x] two\n- [ ] three\n';

function run(req, setupOpts = {}) {
  const root = plainTree({ ...setupOpts, reqs: [req] });
  const r = listRequests(root).requests.find((x) => x.id === req.id);
  const out = applyAnswer(root, r, ctx);
  return { root, out };
}

test('design approve', () => {
  const { root, out } = run(answered({ kind: 'gate', gate: 'design-approval', answer: 'approve' }), { files: { 'docs/design/bulk-export.md': DESIGN } });
  assert.equal(fmOf(root, 'docs/design/bulk-export.md').status, 'APPROVED');
  assert.equal(fmOf(root, 'docs/feat-req/bulk-export.md').status, 'DESIGNED');
  assert.equal(out.agentInput, null);
  assert.ok(out.paths.includes('docs/design/bulk-export.md'));
});

test('design reject', () => {
  const { root, out } = run(answered({ kind: 'gate', gate: 'design-approval', answer: 'reject', notes: 'Rethink the schema' }), { files: { 'docs/design/bulk-export.md': DESIGN } });
  assert.equal(fmOf(root, 'docs/design/bulk-export.md').status, 'DRAFT');
  assert.equal(fmOf(root, 'docs/feat-req/bulk-export.md').status, 'ACCEPTED');
  assert.equal(out.agentInput, 'Rethink the schema');
});

test('triage accept / park / reject', () => {
  const acc = run(answered({ kind: 'gate', gate: 'triage', answer: 'accept' }), { fm: { status: 'PROPOSED' } });
  assert.equal(fmOf(acc.root, 'docs/feat-req/bulk-export.md').status, 'ACCEPTED');
  assert.equal(acc.out.agentInput, null);
  const park = run(answered({ kind: 'gate', gate: 'triage', answer: 'park', notes: 'Not this quarter' }), { fm: { status: 'PROPOSED' } });
  assert.equal(fmOf(park.root, 'docs/feat-req/bulk-export.md').status, 'PARKED');
  assert.match(read(park.root, 'docs/feat-req/bulk-export.md'), /## Triage\n[^]*Not this quarter/);
  const rej = run(answered({ kind: 'gate', gate: 'triage', answer: 'reject', notes: 'Duplicate' }), { fm: { status: 'PROPOSED' } });
  assert.equal(fmOf(rej.root, 'docs/feat-req/bulk-export.md').status, 'REJECTED');
  assert.match(read(rej.root, 'docs/feat-req/bulk-export.md'), /## Triage\n[^]*Duplicate/);
});

test('review {F1: fix, F2: accept}', () => {
  const req = answered({
    kind: 'gate', gate: 'review-findings', answer: { F1: 'fix', F2: 'accept' }, notes: 'Known limitation',
    sections: { Findings: '### F1: Missing null check\n\ntext\n\n### F2 — Slow path\n\ntext' },
  });
  const { root, out } = run(req, { files: { 'docs/plans/bulk-export.md': PLAN } });
  const plan = read(root, 'docs/plans/bulk-export.md');
  assert.match(plan, new RegExp(`### Review fixes \\(${req.id}\\)\\n\\n- \\[ \\] Fix review finding F1: Missing null check \\(request ${req.id}\\)`));
  const feat = read(root, 'docs/feat-req/bulk-export.md');
  assert.match(feat, new RegExp(`2026-11-20 · ${req.id} · review: F2 accept — Known limitation \\(applied by ${WHO}\\)`));
  assert.equal(out.agentInput, null);
});

test('policy approve / reject (back one step)', () => {
  const ap = run(answered({ kind: 'gate', gate: 'merge', answer: 'approve' }), { fm: { status: 'IN_PROGRESS' } });
  assert.equal(ap.out.agentInput, 'proceed with the gated step');
  assert.equal(fmOf(ap.root, 'docs/feat-req/bulk-export.md').status, 'IN_PROGRESS');
  const steps = [['IN_PROGRESS', 'PLANNED'], ['PLANNED', 'DESIGNED'], ['DESIGNED', 'ACCEPTED'], ['ACCEPTED', 'ACCEPTED']];
  for (const [from, to] of steps) {
    const rj = run(answered({ kind: 'gate', gate: 'merge', answer: 'reject', notes: 'not yet' }), { fm: { status: from } });
    assert.equal(fmOf(rj.root, 'docs/feat-req/bulk-export.md').status, to);
    assert.equal(rj.out.agentInput, 'not yet');
  }
});

test('question: option letter, option plus notes, text', () => {
  const opts = '- **A** one\n- **B** two';
  const a = run(answered({ kind: 'question', sections: { Options: opts }, answer: 'B' }));
  assert.equal(a.out.agentInput, 'Option B');
  const b = run(answered({ kind: 'question', sections: { Options: opts }, answer: 'A', notes: 'but be careful' }));
  assert.equal(b.out.agentInput, 'Option A\nbut be careful');
  const t = run(answered({ kind: 'question', sections: { Options: opts }, answer: 'text', notes: 'do C instead' }));
  assert.equal(t.out.agentInput, 'do C instead');
});

test('clarification correct, plan not IMPLEMENTED: rework step after last checked step', () => {
  const req = answered({ kind: 'clarification', sections: { Assumption: 'x' }, answer: 'correct', notes: 'Use UTC\nmore detail' });
  const { root, out } = run(req, { fm: { status: 'IN_PROGRESS' }, files: { 'docs/plans/bulk-export.md': PLAN } });
  assert.match(read(root, 'docs/plans/bulk-export.md'), new RegExp(`- \\[x\\] two\\n- \\[ \\] Rework \\(clarification ${req.id}\\): Use UTC\\n- \\[ \\] three`));
  assert.equal(out.agentInput, null);
  const conf = run(answered({ kind: 'clarification', sections: { Assumption: 'x' }, answer: 'confirm' }), { files: { 'docs/plans/bulk-export.md': PLAN } });
  assert.equal(read(conf.root, 'docs/plans/bulk-export.md'), PLAN);
});

test('clarification correct, no plan: correction is agent input', () => {
  const { out } = run(answered({ kind: 'clarification', sections: { Assumption: 'x' }, answer: 'correct', notes: 'Use UTC' }));
  assert.equal(out.agentInput, 'Use UTC');
});

test('clarification correct, feat-req IMPLEMENTED: follow-up feat-req and triage gate', () => {
  const req = answered({ kind: 'clarification', sections: { Assumption: 'x' }, answer: 'correct', notes: 'Use UTC' });
  const { root, out } = run(req, { fm: { status: 'IMPLEMENTED' } });
  const fslug = `bulk-export-followup-${req.id}`;
  const f = fmOf(root, `docs/feat-req/${fslug}.md`);
  assert.equal(f.status, 'ACCEPTED');
  assert.equal(f.source, `Clarification ${req.id} on bulk-export`);
  assert.equal(f.priority, 'Medium');
  assert.match(read(root, `docs/feat-req/${fslug}.md`), /# Follow-up: bulk-export \(clarification .+\)\n\n## Problem & Context\n\nUse UTC/);
  assert.equal(out.newRequests.length, 1);
  const n = out.newRequests[0];
  assert.deepEqual([n.kind, n.gate, n.scope, n.effort, n.blocking, n.for], ['gate', 'triage', 'effort', fslug, true, 'owner']);
  assert.equal(out.agentInput, null);
});

test('effort error park / retry / text', () => {
  const sections = { Error: '```\nboom: it broke\nstack\n```' };
  const p = run(answered({ kind: 'error', sections, answer: 'park' }));
  assert.equal(fmOf(p.root, 'docs/feat-req/bulk-export.md').status, 'PARKED');
  assert.match(read(p.root, 'docs/feat-req/bulk-export.md'), /## Triage\n[^]*boom: it broke/);
  assert.equal(p.out.agentInput, null);
  assert.equal(run(answered({ kind: 'error', sections, answer: 'retry' })).out.agentInput, 'resume');
  assert.equal(run(answered({ kind: 'error', sections, answer: 'text', notes: 'skip the cache' })).out.agentInput, 'skip the cache');
});

test('worker error resolved: nothing applied', () => {
  const req = answered({ kind: 'error', scope: 'worker', effort: null, sections: { Error: 'x' }, answer: 'resolved' });
  const root = plainTree({ reqs: [req] });
  const r = listRequests(root).requests[0];
  assert.deepEqual(applyAnswer(root, r, ctx), { paths: [], agentInput: null, newRequests: [] });
});

async function claimed(fx, name = 'a') {
  const clone = fx.clone(name);
  const r = await claim(clone, SLUG, { claimant: WHO, workerId: WHO, identity: IDENT, now: NOW, ttlMs: 4 * 3600e3, isAwaitingOpen: () => false });
  assert.equal(r.ok, true);
  return clone;
}

test('applyAnswered: one apply commit, request files gone, awaiting cleared, Decisions cites each id', async () => {
  const q = answered({ kind: 'question', sections: { Options: '- **A** one' }, answer: 'A' });
  const t = answered({ kind: 'error', sections: { Error: 'e' }, answer: 'retry' });
  const fx = setup({ fm: { title: 'Bulk export', status: 'IN_PROGRESS', awaiting: q.id }, reqs: [q, t] });
  const clone = await claimed(fx);
  const before = g(clone, 'rev-list', '--count', 'HEAD');
  const r = await applyAnswered(clone, SLUG, { claimant: WHO, identity: IDENT, workerId: WHO, now: NOW });
  assert.equal(r.ok, true);
  assert.deepEqual(r.agentInput, [`Request ${q.id} (question): Option A`, `Request ${t.id} (error): resume`]);
  assert.equal(Number(g(clone, 'rev-list', '--count', 'HEAD')) - Number(before), 1);
  assert.match(g(clone, 'log', '-1', '--format=%B'), /^board\(apply\): bulk-export[^]*Worker: a-worker1[^]*Effort: bulk-export/);
  g(clone, 'fetch', 'origin', 'main');
  assert.equal(g(clone, 'rev-parse', 'HEAD'), g(clone, 'rev-parse', 'origin/main'));
  assert.equal(existsSync(join(clone, `board/requests/${q.id}.md`)), false);
  assert.equal(existsSync(join(clone, `board/requests/${t.id}.md`)), false);
  const feat = read(clone, 'docs/feat-req/bulk-export.md');
  assert.ok(feat.includes(q.id) && feat.includes(t.id));
  assert.equal(fmOf(clone, 'docs/feat-req/bulk-export.md').awaiting, undefined);
  assert.equal(fmOf(clone, 'docs/feat-req/bulk-export.md').claimed_by, WHO);
});

test('applyAnswered: a park answer lands even though it ends the claim holdability', async () => {
  const e = answered({ kind: 'error', sections: { Error: 'boom' }, answer: 'park' });
  const fx = setup({ fm: { title: 'Bulk export', status: 'IN_PROGRESS', awaiting: e.id }, reqs: [e] });
  const clone = await claimed(fx);
  const r = await applyAnswered(clone, SLUG, { claimant: WHO, identity: IDENT, workerId: WHO, now: NOW });
  assert.deepEqual(r, { ok: true, agentInput: [], problems: [] });
  assert.equal(fmOf(clone, 'docs/feat-req/bulk-export.md').status, 'PARKED');
});

test('applyAnswered pushes nothing if the claim is no longer held', async () => {
  const q = answered({ kind: 'question', sections: { Options: '- **A** one' }, answer: 'A' });
  const fx = setup({ fm: { title: 'Bulk export', status: 'IN_PROGRESS', claimed_by: 'someone-else', claimed_at: '2026-11-20T11:00:00Z', renewed_at: '2026-11-20T11:00:00Z' }, reqs: [q] });
  const clone = fx.clone('a');
  const head = g(clone, 'rev-parse', 'HEAD');
  const r = await applyAnswered(clone, SLUG, { claimant: WHO, identity: IDENT, workerId: WHO, now: NOW });
  assert.deepEqual(r, { ok: false, reason: 'replaced', agentInput: [], problems: [] });
  assert.equal(g(clone, 'rev-parse', 'HEAD'), head);
  g(clone, 'fetch', 'origin', 'main');
  assert.equal(g(clone, 'rev-parse', 'origin/main'), head);
  assert.equal(existsSync(join(clone, `board/requests/${q.id}.md`)), true);
});

test('applyAnswered with no answered requests is ok and commits nothing', async () => {
  const fx = setup({ fm: { title: 'Bulk export', status: 'IN_PROGRESS' } });
  const clone = await claimed(fx);
  const head = g(clone, 'rev-parse', 'HEAD');
  assert.deepEqual(await applyAnswered(clone, SLUG, { claimant: WHO, identity: IDENT, workerId: WHO, now: NOW }), { ok: true, agentInput: [], problems: [] });
  assert.equal(g(clone, 'rev-parse', 'HEAD'), head);
});

const apply = (clone) => applyAnswered(clone, SLUG, { claimant: WHO, identity: IDENT, workerId: WHO, now: NOW });
const dirty = (clone) => g(clone, 'status', '--porcelain');

test('applyAnswered is all-or-nothing: a throw on the second request leaves a clean tree and no commit', async () => {
  const q = answered({ kind: 'question', sections: { Options: '- **A** one' }, answer: 'A' });
  const d = answered({ kind: 'gate', gate: 'design-approval', answer: 'approve' });
  // docs/design/bulk-export.md is a directory, so reading it throws after the first request was applied
  const fx = setup({ fm: { title: 'Bulk export', status: 'IN_PROGRESS' }, files: { 'docs/design/bulk-export.md/x': 'x' }, reqs: [q, d] });
  const clone = await claimed(fx);
  const head = g(clone, 'rev-parse', 'HEAD');
  await assert.rejects(apply(clone));
  assert.equal(dirty(clone), '');
  assert.equal(g(clone, 'rev-parse', 'HEAD'), head);
  assert.equal(existsSync(join(clone, `board/requests/${q.id}.md`)), true);
  assert.ok(!read(clone, 'docs/feat-req/bulk-export.md').includes(q.id));
});

test('applyAnswered skips invalid answers, keeps their files and awaiting, and reports them', async () => {
  const bad = [
    answered({ kind: 'gate', gate: 'triage', answer: 'maybe' }),
    answered({ kind: 'gate', gate: 'merge', answer: 'aprove' }),
    answered({ kind: 'gate', gate: 'review-findings', answer: {}, sections: { Findings: '### F1: x' } }),
  ];
  const good = answered({ kind: 'question', sections: { Options: '- **A** one' }, answer: 'A' });
  const fx = setup({ fm: { title: 'Bulk export', status: 'IN_PROGRESS', awaiting: bad[0].id }, reqs: [...bad, good] });
  const clone = await claimed(fx);
  const r = await apply(clone);
  assert.equal(r.ok, true);
  assert.deepEqual(r.problems.map((p) => p.id), bad.map((b) => b.id));
  assert.ok(r.agentInput.some((l) => l.startsWith(`Request ${bad[1].id} could not be applied: `)));
  assert.ok(r.agentInput.includes(`Request ${good.id} (question): Option A`));
  for (const b of bad) assert.equal(existsSync(join(clone, `board/requests/${b.id}.md`)), true);
  assert.equal(existsSync(join(clone, `board/requests/${good.id}.md`)), false);
  const fm = fmOf(clone, 'docs/feat-req/bulk-export.md');
  assert.equal(fm.status, 'IN_PROGRESS');
  assert.equal(fm.awaiting, bad[0].id);
});

test('applyAnswered ignores worker-scope requests that carry an effort', async () => {
  const w = answered({ kind: 'error', scope: 'worker', sections: { Error: 'x' }, answer: 'resolved' });
  const fx = setup({ fm: { title: 'Bulk export', status: 'IN_PROGRESS' }, reqs: [w] });
  const clone = await claimed(fx);
  const head = g(clone, 'rev-parse', 'HEAD');
  assert.deepEqual(await apply(clone), { ok: true, agentInput: [], problems: [] });
  assert.equal(g(clone, 'rev-parse', 'HEAD'), head);
  assert.equal(existsSync(join(clone, `board/requests/${w.id}.md`)), true);
});

test('applyAnswered after a lost race applies once: one Decisions line, one plan step, files deleted', async () => {
  const rv = answered({
    kind: 'gate', gate: 'review-findings', answer: { F1: 'fix' }, sections: { Findings: '### F1: Missing check' },
  });
  const fx = setup({ fm: { title: 'Bulk export', status: 'IN_PROGRESS' }, files: { 'docs/plans/bulk-export.md': PLAN }, reqs: [rv] });
  const clone = await claimed(fx);
  let raced = false;
  const hooks = { beforePush: () => { if (!raced) { raced = true; fx.seed('unrelated.txt', 'x'); } } };
  const r = await applyAnswered(clone, SLUG, { claimant: WHO, identity: IDENT, workerId: WHO, now: NOW, hooks });
  assert.equal(r.ok, true);
  assert.equal(raced, true);
  const feat = read(clone, 'docs/feat-req/bulk-export.md');
  assert.equal(feat.split(rv.id).length - 1, 1);
  assert.equal(read(clone, 'docs/plans/bulk-export.md').split('Fix review finding F1').length - 1, 1);
  assert.equal(existsSync(join(clone, `board/requests/${rv.id}.md`)), false);
  assert.equal(g(clone, 'log', '--format=%s', '--grep=board(apply)').split('\n').length, 1);
});

test('path guards: unsafe effort or id never reaches the filesystem', () => {
  const root = plainTree();
  const req = (over) => ({ id: '202611201000-abcde1', path: 'x', fm: { id: '202611201000-abcde1', kind: 'question', scope: 'effort', effort: SLUG, answer: 'A', ...over }, sections: { Answer: '' } });
  assert.throws(() => applyAnswer(root, req({ effort: '../../evil' }), ctx), /unsafe/);
  assert.throws(() => applyAnswer(root, { ...req({}), id: '../../x' }, ctx), /unsafe/);
});

test('applyClosed skips an answered request whose effort is a path, and reports it', async () => {
  const evil = answered({ kind: 'question', effort: '../evil', sections: { Options: '- **A** one' }, answer: 'A' });
  const fx = setup({ fm: { title: 'Bulk export', status: 'IMPLEMENTED' }, reqs: [evil] });
  const clone = fx.clone('a');
  const head = g(clone, 'rev-parse', 'HEAD');
  const r = await applyClosed(clone, { identity: IDENT, workerId: WHO, now: NOW });
  assert.equal(r.ok, true);
  assert.deepEqual(r.applied, []);
  assert.equal(r.problems[0].id, evil.id);
  assert.equal(g(clone, 'rev-parse', 'HEAD'), head);
});

test('applyClosed: clarification corrected after IMPLEMENTED files a follow-up and its triage gate in one commit', async () => {
  const c = answered({ kind: 'clarification', sections: { Assumption: 'x' }, answer: 'correct', notes: 'Use UTC' });
  const k = answered({ kind: 'clarification', sections: { Assumption: 'y' }, answer: 'confirm' });
  const fx = setup({ fm: { title: 'Bulk export', status: 'IMPLEMENTED' }, reqs: [c, k] });
  const clone = fx.clone('a');
  const before = g(clone, 'rev-list', '--count', 'HEAD');
  const r = await applyClosed(clone, { identity: IDENT, workerId: WHO, now: NOW });
  assert.deepEqual(r, { ok: true, applied: [c.id, k.id], problems: [] });
  assert.equal(Number(g(clone, 'rev-list', '--count', 'HEAD')) - Number(before), 1);
  assert.match(g(clone, 'log', '-1', '--format=%B'), /^board\(apply\): closed[^]*Worker: a-worker1/);
  g(clone, 'fetch', 'origin', 'main');
  assert.equal(g(clone, 'rev-parse', 'HEAD'), g(clone, 'rev-parse', 'origin/main'));
  const fslug = `bulk-export-followup-${c.id}`;
  const f = fmOf(clone, `docs/feat-req/${fslug}.md`);
  assert.equal(f.status, 'ACCEPTED');
  const gate = listRequests(clone).requests;
  assert.equal(gate.length, 1);
  assert.equal(gate[0].fm.gate, 'triage');
  assert.equal(gate[0].fm.effort, fslug);
  assert.equal(f.awaiting, gate[0].id);
  assert.equal(existsSync(join(clone, `board/requests/${c.id}.md`)), false);
  assert.equal(existsSync(join(clone, `board/requests/${k.id}.md`)), false);
  const feat = read(clone, 'docs/feat-req/bulk-export.md');
  assert.ok(feat.includes(c.id) && feat.includes(k.id));
});

test('applyClosed with nothing to do commits nothing', async () => {
  const fx = setup({ fm: { title: 'Bulk export', status: 'IN_PROGRESS' } });
  const clone = fx.clone('a');
  const head = g(clone, 'rev-parse', 'HEAD');
  assert.deepEqual(await applyClosed(clone, { identity: IDENT, workerId: WHO, now: NOW }), { ok: true, applied: [], problems: [] });
  assert.equal(g(clone, 'rev-parse', 'HEAD'), head);
});

test('symlinked plan file: the write is refused, the outside file is untouched, the tree is clean', async () => {
  const rv = answered({ kind: 'gate', gate: 'review-findings', answer: { F1: 'fix' }, sections: { Findings: '### F1: x' } });
  const fx = setup({ fm: { title: 'Bulk export', status: 'IN_PROGRESS' }, reqs: [rv] });
  const outside = join(mkdtempSync(join(tmpdir(), 'outside-')), 'target.md');
  writeFileSync(outside, '# outside\n');
  const pusher = fx.clone('pusher');
  mkdirSync(join(pusher, 'docs/plans'), { recursive: true });
  symlinkSync(outside, join(pusher, 'docs/plans/bulk-export.md'));
  g(pusher, 'add', '-A'); g(pusher, 'commit', '-m', 'symlink'); g(pusher, 'push', 'origin', 'main');
  const clone = await claimed(fx);
  const head = g(clone, 'rev-parse', 'HEAD');
  await assert.rejects(apply(clone), /symlink/);
  assert.equal(readFileSync(outside, 'utf8'), '# outside\n');
  assert.equal(dirty(clone), '');
  assert.equal(g(clone, 'rev-parse', 'HEAD'), head);
});

test('symlinked docs/feat-req directory: applyClosed refuses and reports', async () => {
  const c = answered({ kind: 'clarification', sections: { Assumption: 'x' }, answer: 'confirm' });
  const fx = setup({ fm: { title: 'Bulk export', status: 'IMPLEMENTED' }, reqs: [c] });
  const outsideDir = mkdtempSync(join(tmpdir(), 'outside-'));
  writeFileSync(join(outsideDir, 'bulk-export.md'), '---\nstatus: IMPLEMENTED\n---\n');
  const pusher = fx.clone('pusher');
  g(pusher, 'rm', '-rq', 'docs/feat-req');
  mkdirSync(join(pusher, 'docs'), { recursive: true });
  symlinkSync(outsideDir, join(pusher, 'docs/feat-req'));
  g(pusher, 'add', '-A'); g(pusher, 'commit', '-m', 'symlink dir'); g(pusher, 'push', 'origin', 'main');
  const clone = fx.clone('a');
  const r = await applyClosed(clone, { identity: IDENT, workerId: WHO, now: NOW });
  assert.deepEqual(r.applied, []);
  assert.match(r.problems[0].problems[0], /symlink/);
  assert.equal(readFileSync(join(outsideDir, 'bulk-export.md'), 'utf8'), '---\nstatus: IMPLEMENTED\n---\n');
  assert.equal(dirty(clone), '');
  assert.equal(existsSync(join(clone, `board/requests/${c.id}.md`)), true);
});

test('applyClosed applies only clarifications: an error park on an IMPLEMENTED effort is reported and kept', async () => {
  const e = answered({ kind: 'error', sections: { Error: 'boom' }, answer: 'park' });
  const fx = setup({ fm: { title: 'Bulk export', status: 'IMPLEMENTED' }, reqs: [e] });
  const clone = fx.clone('a');
  const head = g(clone, 'rev-parse', 'HEAD');
  const r = await applyClosed(clone, { identity: IDENT, workerId: WHO, now: NOW });
  assert.deepEqual(r.applied, []);
  assert.equal(r.problems[0].id, e.id);
  assert.equal(fmOf(clone, 'docs/feat-req/bulk-export.md').status, 'IMPLEMENTED');
  assert.equal(existsSync(join(clone, `board/requests/${e.id}.md`)), true);
  assert.equal(g(clone, 'rev-parse', 'HEAD'), head);
});
