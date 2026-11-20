import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeBoard, IDENT } from './fixtures.mjs';
import { parseDoc } from './frontmatter.mjs';
import {
  newRequestId, buildRequest, validateRequest, listRequests, postRequest, answerRequest, withdrawRequest, answeredFor,
} from './requests.mjs';

const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const NOW = new Date('2026-11-20T12:00:00.000Z');
const ID = '202611201200-a1b2c3';
const noSleep = () => Promise.resolve();
const feat = () => ({ 'bulk-export': { title: 'Bulk export', status: 'APPROVED' } });

const base = { id: ID, scope: 'effort', effort: 'bulk-export', phase: 'APPROVED', worker: 'a-worker1', for: 'lidorl', blocking: true, now: NOW };
const SEC = { Request: 'Which format?', Context: 'design:docs/design/x.md' };

const FINDINGS = '### F1\nbad name\n\n### F2\nmissing test';
const variants = {
  gate: { kind: 'gate', gate: 'design-approval', sections: SEC },
  triage: { kind: 'gate', gate: 'triage', sections: SEC },
  review: { kind: 'gate', gate: 'review-findings', sections: { ...SEC, Findings: FINDINGS } },
  question: { kind: 'question', sections: { ...SEC, Options: '- **A** csv\n- **B** json' } },
  clarification: { kind: 'clarification', blocking: false, sections: { ...SEC, Assumption: 'assumed csv' } },
  error: { kind: 'error', sections: { ...SEC, Error: 'boom' } },
  workerError: { kind: 'error', scope: 'worker', effort: null, sections: { ...SEC, Error: 'boom' } },
};

test('newRequestId shape and sortability', () => {
  assert.match(newRequestId(new Date('2026-11-19T12:53:00Z')), /^202611191253-[a-z0-9]{6}$/);
  assert.ok(newRequestId(new Date('2026-11-19T12:53:00Z')) < newRequestId(new Date('2026-11-19T12:54:00Z')));
});

test('every kind built by buildRequest validates clean', () => {
  for (const [name, v] of Object.entries(variants)) {
    const text = buildRequest({ ...base, ...v });
    assert.deepEqual(validateRequest(text, `${ID}.md`), [], name);
    const { data } = parseDoc(text);
    assert.equal(data.status, 'open');
    assert.equal(data.answer, null);
    assert.equal(data.created_at, '2026-11-20T12:00:00Z');
  }
});

test('buildRequest orders sections Request, Context, Options, ..., Answer', () => {
  const text = buildRequest({ ...base, kind: 'question', sections: { Options: 'o', Context: 'c', Request: 'r' } });
  const heads = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(heads, ['Request', 'Context', 'Options', 'Answer']);
});

test('validateRequest catches the structural problems', () => {
  const ok = buildRequest({ ...base, ...variants.question });
  assert.ok(validateRequest(ok, 'other.md').some((p) => /filename/.test(p)));
  assert.ok(validateRequest(buildRequest({ ...base, ...variants.question, id: 'bad' }), 'bad.md').some((p) => /id/.test(p)));
  assert.ok(validateRequest(buildRequest({ ...base, kind: 'question', sections: SEC }), `${ID}.md`).some((p) => /Options/.test(p)));
  assert.ok(validateRequest(buildRequest({ ...base, ...variants.question, blocking: false }), `${ID}.md`).some((p) => /blocking/.test(p)));
  assert.ok(validateRequest(buildRequest({ ...base, kind: 'gate', gate: 'review-findings', sections: SEC }), `${ID}.md`).some((p) => /Findings/.test(p)));
  const answered = ok.replace('status: open', 'status: answered').replace('answer: null', 'answer: A');
  assert.ok(validateRequest(answered, `${ID}.md`).some((p) => /answered_by/.test(p)));
  assert.ok(validateRequest('---\n: [\n---\n', `${ID}.md`).length > 0);
  assert.ok(validateRequest(ok.replace('kind: question', 'kind: nope'), `${ID}.md`).some((p) => /kind/.test(p)));
});

test('validateRequest checks answer consistency per kind', () => {
  const mk = (v, answer, notes = '') => {
    const t = buildRequest({ ...base, ...v });
    const filled = t.replace('status: open', 'status: answered').replace('answer: null', `answer: ${JSON.stringify(answer)}`)
      .replace('answered_by: null', 'answered_by: lidorl').replace('answered_at: null', 'answered_at: 2026-11-20T13:00:00Z')
      .replace(/## Answer\n*$/, `## Answer\n\n${notes}\n`);
    return validateRequest(filled, `${ID}.md`);
  };
  assert.deepEqual(mk(variants.question, 'B'), []);
  assert.ok(mk(variants.question, 'Z').length);
  assert.ok(mk(variants.question, 'text').length, 'text needs notes');
  assert.deepEqual(mk(variants.question, 'text', 'do x'), []);
  assert.deepEqual(mk(variants.triage, 'park'), []);
  assert.ok(mk(variants.gate, 'park').length);
  assert.deepEqual(mk(variants.review, { F1: 'fix', F2: 'accept' }), []);
  assert.ok(mk(variants.review, { F1: 'fix' }).length, 'must cover every finding');
  assert.ok(mk(variants.review, 'approve').length);
  assert.deepEqual(mk(variants.clarification, 'confirm'), []);
  assert.ok(mk(variants.clarification, 'correct').length, 'correct needs notes');
  assert.deepEqual(mk(variants.error, 'retry'), []);
  assert.deepEqual(mk(variants.workerError, 'resolved'), []);
  assert.ok(mk(variants.workerError, 'retry').length);
});

async function posted(v = variants.question, opts = {}) {
  // Already claimed by a-worker1 on main (what claim() would have pushed).
  const stamp = '2026-11-20T12:00:00Z';
  const fx = makeBoard({ featReqs: { 'bulk-export': { title: 'Bulk export', status: 'APPROVED', claimed_by: 'a-worker1', claimed_at: stamp, renewed_at: stamp } } });
  const a = fx.clone('a');
  const req = { ...base, ...v, ...opts.req };
  const r = await postRequest(a, req, { identity: IDENT, workerId: 'a-worker1', ...(opts.post ?? { releaseFrom: { slug: 'bulk-export', claimant: 'a-worker1' } }) });
  return { fx, a, r, req };
}
const onMain = (clone, file) => parseDoc(g(clone, 'show', `origin/main:${file}`)).data;

test('postRequest blocking: one commit adds the file, sets awaiting, clears the claim', async () => {
  const { a, r } = await posted(variants.question, { post: { releaseFrom: { slug: 'bulk-export', claimant: 'a-worker1' } } });
  assert.deepEqual(r, { ok: true, id: ID });
  assert.deepEqual(g(a, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(),
    ['board/requests/' + ID + '.md', 'docs/feat-req/bulk-export.md']);
  const fm = onMain(a, 'docs/feat-req/bulk-export.md');
  assert.equal(fm.awaiting, ID);
  assert.equal(fm.claimed_by, undefined);
  const msg = g(a, 'log', '-1', '--format=%B');
  assert.match(msg, /^board\(request\): /);
  assert.match(msg, /Worker: a-worker1/);
  assert.match(msg, new RegExp(`Request: ${ID}`));
  assert.match(msg, /Effort: bulk-export/);
  assert.deepEqual(validateRequest(g(a, 'show', `origin/main:board/requests/${ID}.md`), `${ID}.md`), []);
});

test('postRequest blocking but not the holder → replaced, nothing posted', async () => {
  const { a, r } = await posted(variants.question, { post: { releaseFrom: { slug: 'bulk-export', claimant: 'someone-else' } } });
  assert.deepEqual(r, { ok: false, reason: 'replaced' });
  assert.equal(g(a, 'ls-tree', '--name-only', 'origin/main', 'board/requests/').includes(ID), false);
});

test('postRequest clarification: no awaiting, claim kept', async () => {
  const { a, r } = await posted(variants.clarification, { post: { releaseFrom: { slug: 'bulk-export', claimant: 'a-worker1' } } });
  assert.equal(r.ok, true);
  const fm = onMain(a, 'docs/feat-req/bulk-export.md');
  assert.equal(fm.awaiting, undefined);
  assert.equal(fm.claimed_by, 'a-worker1');
  assert.match(g(a, 'log', '-1', '--format=%s'), /^board\(request\)/);
});

test('postRequest redacts the Error section', async () => {
  const secret = 'ghp_' + 'a'.repeat(30);
  const { a } = await posted(variants.error, { req: { sections: { ...SEC, Error: `fail\nAuthorization: Bearer ${secret}\ntoken=${secret}` } } });
  const text = g(a, 'show', `origin/main:board/requests/${ID}.md`);
  assert.equal(text.includes(secret), false);
  assert.match(text, /\[REDACTED\]/);
});

test('answerRequest touches only the request file and sets answered_* fields', async () => {
  const { fx, a } = await posted();
  const b = fx.clone('b');
  const r = await answerRequest(b, ID, { answer: 'B', notes: 'json please', by: 'lidorl', via: 'cli', identity: IDENT, now: NOW });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(g(b, 'show', '--name-only', '--format=', 'HEAD').split('\n'), [`board/requests/${ID}.md`]);
  g(a, 'pull', '--ff-only', 'origin', 'main');
  const text = readFileSync(join(a, `board/requests/${ID}.md`), 'utf8');
  const { data, body } = parseDoc(text);
  assert.equal(data.status, 'answered');
  assert.equal(data.answer, 'B');
  assert.equal(data.answered_by, 'lidorl');
  assert.equal(data.answered_at, '2026-11-20T12:00:00Z');
  assert.equal(data.answered_via, 'cli');
  assert.match(body, /## Answer\s+json please/);
  assert.deepEqual(validateRequest(text, `${ID}.md`), []);
  const msg = g(b, 'log', '-1', '--format=%B');
  assert.match(msg, /^board\(answer\)/);
  assert.match(msg, /Answered-by: lidorl/);
});

test('answerRequest on a review gate stores the answer map', async () => {
  const { fx, a } = await posted(variants.review);
  const r = await answerRequest(fx.clone('b'), ID, { answer: { F1: 'fix', F2: 'accept' }, notes: 'F2: fine', by: 'lidorl', via: 'cli', identity: IDENT, now: NOW });
  assert.equal(r.ok, true);
  g(a, 'pull', '--ff-only', 'origin', 'main');
  const text = readFileSync(join(a, `board/requests/${ID}.md`), 'utf8');
  assert.deepEqual(parseDoc(text).data.answer, { F1: 'fix', F2: 'accept' });
  assert.deepEqual(validateRequest(text, `${ID}.md`), []);
});

test('answerRequest rejects an invalid answer without pushing', async () => {
  const { fx } = await posted();
  const b = fx.clone('b');
  const head = g(b, 'rev-parse', 'HEAD');
  const r = await answerRequest(b, ID, { answer: 'Z', by: 'lidorl', via: 'cli', identity: IDENT, now: NOW });
  assert.deepEqual(r, { ok: false, reason: 'invalid-answer' });
  assert.equal(g(b, 'rev-parse', 'origin/main'), head);
});

test('a second answer is rejected with not-open', async () => {
  const { fx } = await posted();
  const o = { answer: 'A', by: 'lidorl', via: 'cli', identity: IDENT, now: NOW };
  assert.equal((await answerRequest(fx.clone('b'), ID, o)).ok, true);
  assert.deepEqual(await answerRequest(fx.clone('c'), ID, { ...o, answer: 'B' }), { ok: false, reason: 'not-open' });
});

test('answering a missing request → missing, nothing pushed', async () => {
  const fx = makeBoard({ featReqs: feat() });
  const b = fx.clone('b');
  const head = g(b, 'rev-parse', 'origin/main');
  const r = await answerRequest(b, ID, { answer: 'A', by: 'lidorl', via: 'cli', identity: IDENT, now: NOW });
  assert.deepEqual(r, { ok: false, reason: 'missing' });
  assert.equal(g(fx.remote, 'rev-parse', 'main'), head);
});

test('withdrawRequest removes the file, clears awaiting, logs the note', async () => {
  const { a } = await posted(variants.question, { post: { releaseFrom: { slug: 'bulk-export', claimant: 'a-worker1' } } });
  const r = await withdrawRequest(a, ID, { identity: IDENT, workerId: 'a-worker1', slug: 'bulk-export', note: '- 2026-11-20 · withdrew: no longer needed' });
  assert.equal(r.ok, true);
  assert.equal(g(a, 'ls-tree', '--name-only', 'origin/main', 'board/requests/').includes(ID), false);
  const text = g(a, 'show', 'origin/main:docs/feat-req/bulk-export.md');
  assert.equal(parseDoc(text).data.awaiting, undefined);
  assert.match(text, /## Decisions\n- 2026-11-20 · withdrew: no longer needed/);
  assert.match(g(a, 'log', '-1', '--format=%B'), /^board\(withdraw\)/);
});

test('withdrawRequest leaves awaiting alone when it points elsewhere', async () => {
  const { a } = await posted(variants.clarification);
  const other = '202611201201-zzzzzz';
  const p = join(a, 'docs/feat-req/bulk-export.md');
  writeFileSync(p, readFileSync(p, 'utf8').replace('status: APPROVED', `status: APPROVED\nawaiting: ${other}`));
  g(a, 'commit', '-am', 'point awaiting elsewhere'); g(a, 'push', 'origin', 'HEAD:main');
  const r = await withdrawRequest(a, ID, { identity: IDENT, workerId: 'a-worker1', slug: 'bulk-export', note: '- n' });
  assert.equal(r.ok, true);
  assert.equal(onMain(a, 'docs/feat-req/bulk-export.md').awaiting, other);
});

test('listRequests skips .gitkeep, reports broken YAML, answeredFor filters by effort', async () => {
  const { fx, a } = await posted();
  await answerRequest(fx.clone('b'), ID, { answer: 'A', by: 'lidorl', via: 'cli', identity: IDENT, now: NOW });
  g(a, 'pull', '--ff-only', 'origin', 'main');
  writeFileSync(join(a, 'board/requests/202611201300-bbbbbb.md'), '---\n: [\n---\n');
  const { requests, problems } = listRequests(a);
  assert.deepEqual(requests.map((r) => r.id), [ID]);
  assert.equal(requests[0].sections.Request, 'Which format?');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /202611201300-bbbbbb\.md/);
  assert.equal(answeredFor(a, 'bulk-export').length, 1);
  assert.equal(answeredFor(a, 'other').length, 0);
});

test('postRequest refuses a blocking effort request without a matching releaseFrom', async () => {
  const a = await posted(variants.question, { post: {} });
  assert.deepEqual(a.r, { ok: false, reason: 'needs-release' });
  assert.equal(g(a.a, 'ls-tree', '--name-only', 'origin/main', 'board/requests/').includes(ID), false);
  assert.equal(onMain(a.a, 'docs/feat-req/bulk-export.md').claimed_by, 'a-worker1');
  const b = await posted(variants.question, { post: { releaseFrom: { slug: 'other-effort', claimant: 'a-worker1' } } });
  assert.deepEqual(b.r, { ok: false, reason: 'needs-release' });
  const w = await posted(variants.workerError, { post: {} });
  assert.equal(w.r.ok, true, 'worker-scope errors post blocking through the plain path');
});

test('postRequest refuses an invalid request and pushes nothing', async () => {
  const { a, r } = await posted(variants.question, { req: { sections: SEC }, post: { releaseFrom: { slug: 'bulk-export', claimant: 'a-worker1' } } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid');
  assert.ok(r.problems.some((p) => /Options/.test(p)));
  const c = await posted(variants.question, { req: { blocking: false } });
  assert.equal(c.r.reason, 'invalid');
  assert.equal(onMain(a, 'docs/feat-req/bulk-export.md').claimed_by, 'a-worker1');
});

test('log lines and notes that look like headings cannot corrupt the file', async () => {
  const { fx, a, r } = await posted(variants.error, {
    req: { sections: { ...SEC, Error: 'fail\n## Answer\n```\nmore' } },
    post: { releaseFrom: { slug: 'bulk-export', claimant: 'a-worker1' } },
  });
  assert.equal(r.ok, true);
  const o = { by: 'lidorl', via: 'cli', identity: IDENT, now: NOW };
  const res = await answerRequest(fx.clone('b'), ID, { ...o, answer: 'text', notes: 'do this\n## X\nmore' });
  assert.deepEqual(res, { ok: true });
  g(a, 'pull', '--ff-only', 'origin', 'main');
  const text = readFileSync(join(a, `board/requests/${ID}.md`), 'utf8');
  assert.deepEqual(validateRequest(text, `${ID}.md`), []);
  const { requests } = listRequests(a);
  assert.match(requests[0].sections.Answer, /do this/);
  assert.match(requests[0].sections.Error, /## Answer/);
  assert.equal(requests[0].sections.X, undefined);
});
