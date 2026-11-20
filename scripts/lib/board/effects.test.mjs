import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeBoard, IDENT } from './fixtures.mjs';
import { applyAnswer, applyAnswered } from './effects.mjs';
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

function setup({ fm = { title: 'Bulk export', status: 'ACCEPTED' }, files = {}, reqs = [] } = {}) {
  const fx = makeBoard({ featReqs: { [SLUG]: fm } });
  for (const [f, c] of Object.entries(files)) fx.seed(f, c);
  for (const r of reqs) fx.seed(`board/requests/${r.id}.md`, r.text);
  return fx;
}

const read = (root, f) => readFileSync(join(root, f), 'utf8');
const fmOf = (root, f) => parseDoc(read(root, f)).data;
const DESIGN = '---\nstatus: DRAFT\n---\n\n# Design\n';
const PLAN = '---\nstatus: PLANNED\n---\n\n# Plan\n\n- [x] one\n- [x] two\n- [ ] three\n';

function run(req, setupOpts = {}) {
  const fx = setup({ ...setupOpts, reqs: [req] });
  const root = fx.clone('a');
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
  const fx = setup({ reqs: [req] });
  const root = fx.clone('a');
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
  assert.deepEqual(r, { ok: true, agentInput: [] });
  assert.equal(fmOf(clone, 'docs/feat-req/bulk-export.md').status, 'PARKED');
});

test('applyAnswered pushes nothing if the claim is no longer held', async () => {
  const q = answered({ kind: 'question', sections: { Options: '- **A** one' }, answer: 'A' });
  const fx = setup({ fm: { title: 'Bulk export', status: 'IN_PROGRESS', claimed_by: 'someone-else', claimed_at: '2026-11-20T11:00:00Z', renewed_at: '2026-11-20T11:00:00Z' }, reqs: [q] });
  const clone = fx.clone('a');
  const head = g(clone, 'rev-parse', 'HEAD');
  const r = await applyAnswered(clone, SLUG, { claimant: WHO, identity: IDENT, workerId: WHO, now: NOW });
  assert.deepEqual(r, { ok: false, reason: 'replaced', agentInput: [] });
  assert.equal(g(clone, 'rev-parse', 'HEAD'), head);
  g(clone, 'fetch', 'origin', 'main');
  assert.equal(g(clone, 'rev-parse', 'origin/main'), head);
  assert.equal(existsSync(join(clone, `board/requests/${q.id}.md`)), true);
});

test('applyAnswered with no answered requests is ok and commits nothing', async () => {
  const fx = setup({ fm: { title: 'Bulk export', status: 'IN_PROGRESS' } });
  const clone = await claimed(fx);
  const head = g(clone, 'rev-parse', 'HEAD');
  assert.deepEqual(await applyAnswered(clone, SLUG, { claimant: WHO, identity: IDENT, workerId: WHO, now: NOW }), { ok: true, agentInput: [] });
  assert.equal(g(clone, 'rev-parse', 'HEAD'), head);
});
