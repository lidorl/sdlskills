import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeBoard } from './fixtures.mjs';
import { run, reportPaths } from './cli.mjs';
import { claim } from './claims.mjs';
import { buildRequest } from './requests.mjs';
import { parseDoc } from './frontmatter.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const ME = { login: 'lidorl', name: 'Lidor L', email: 'lidorl@example.com' };
const T0 = new Date('2026-06-01T10:00:00Z');
const hours = (n) => new Date(T0.getTime() + n * 3600e3);

async function cli(cwd, argv, { now = T0, whoami = () => ME, sleep = async () => {}, interactive = false, ui, hooks } = {}) {
  let out = '';
  let err = '';
  const code = await run(argv, { cwd, out: (s) => { out += s; }, err: (s) => { err += s; }, now: () => now, whoami, sleep, interactive, ui, hooks });
  return { code, out, err };
}

const feat = (extra = {}) => ({ status: 'ACCEPTED', priority: 'high', date: '2026-05-01', ...extra });
const fmOf = (clone, slug) => parseDoc(readFileSync(join(clone, 'docs/feat-req', `${slug}.md`), 'utf8')).data;
const head = (remote) => git(remote, 'log', '-1', '--format=%B', 'main');

function request(id, over = {}) {
  return buildRequest({
    id, kind: 'clarification', scope: 'effort', effort: 'bulk-export', worker: 'w-aaaaaa', for: 'lidorl', blocking: false,
    now: T0, sections: { Request: 'r', Context: 'c', Assumption: 'a' }, ...over,
  });
}

test('check exits 1 and names a broken request file', async () => {
  const b = makeBoard();
  b.seed('board/requests/bad.md', '---\nid: nope\n---\n');
  const c = b.clone('c');
  const r = await cli(c, ['check']);
  assert.equal(r.code, 1);
  assert.match(r.err, /board\/requests\/bad\.md: /);
  const ok = makeBoard();
  assert.equal((await cli(ok.clone('d'), ['check'])).code, 0);
});

test('next --json ranks and reports overlaps', async () => {
  const b = makeBoard({ featReqs: {
    alpha: feat({ claimed_by: 'someone', claimed_at: '2026-06-01T09:00:00Z' }),
    beta: feat({ priority: 'low' }),
    gamma: feat({ priority: 'high' }),
  } });
  b.seed('docs/design/alpha.md', '---\nrepos: [api, web]\n---\n# a\n');
  b.seed('docs/design/gamma.md', '---\nrepos: [web]\n---\n# g\n');
  const c = b.clone('c');
  const r = await cli(c, ['next', '--json']);
  assert.equal(r.code, 0);
  const j = JSON.parse(r.out);
  assert.equal(j.next.slug, 'gamma');
  assert.deepEqual(j.overlaps, [{ slug: 'alpha', repos: ['web'] }]);
  const text = await cli(c, ['next']);
  assert.match(text.err, /warning: gamma shares web with alpha/);
});

test('claim / report / release round-trip; report carries Phase and renews the lease', async () => {
  const b = makeBoard({ featReqs: { 'bulk-export': feat() } });
  const c = b.clone('c');
  assert.equal((await cli(c, ['claim', 'bulk-export'])).code, 0);
  assert.equal(fmOf(c, 'bulk-export').claimed_by, 'lidorl');

  writeFileSync(join(c, 'docs/feat-req/bulk-export.md'), readFileSync(join(c, 'docs/feat-req/bulk-export.md'), 'utf8').replace('status: ACCEPTED', 'status: DESIGNED'));
  mkdirSync(join(c, 'docs/design'), { recursive: true });
  writeFileSync(join(c, 'docs/design/bulk-export.md'), '# design\n');
  const r = await cli(c, ['report', 'bulk-export', '--phase', 'DESIGNED'], { now: hours(1) });
  assert.equal(r.code, 0, r.err);
  assert.match(head(b.remote), /board\(report\): bulk-export[\s\S]*Effort: bulk-export\nPhase: DESIGNED/);
  assert.ok(!/Worker:/.test(head(b.remote)));
  assert.match(git(b.remote, 'show', '--name-only', '--format=', 'main'), /docs\/design\/bulk-export\.md/);
  assert.equal(new Date(fmOf(c, 'bulk-export').renewed_at).getTime(), hours(1).getTime());
  assert.equal(fmOf(c, 'bulk-export').status, 'DESIGNED');

  assert.equal((await cli(c, ['release', 'bulk-export'])).code, 0);
  assert.equal(fmOf(c, 'bulk-export').claimed_by ?? null, null);
});

test('report after a takeover prints the warning, exits 3, pushes nothing', async () => {
  const b = makeBoard({ featReqs: { 'bulk-export': feat() } });
  const a = b.clone('a');
  const o = b.clone('o');
  assert.equal((await cli(a, ['claim', 'bulk-export'])).code, 0);
  const t = await claim(o, 'bulk-export', {
    claimant: 'lidorl-1a2b3c', identity: ME, now: hours(5), ttlMs: 4 * 3600e3, isAwaitingOpen: () => false,
  });
  assert.ok(t.ok);
  const before = git(b.remote, 'rev-parse', 'main');
  const r = await cli(a, ['report', 'bulk-export', '--phase', 'PLANNED'], { now: hours(5) });
  assert.equal(r.code, 3);
  assert.match(r.err, /bulk-export is now held by lidorl-1a2b3c; nothing was pushed/);
  assert.equal(git(b.remote, 'rev-parse', 'main'), before);
});

test('write commands refuse off main', async () => {
  const b = makeBoard({ featReqs: { 'bulk-export': feat() } });
  const c = b.clone('c');
  git(c, 'checkout', '-b', 'topic');
  for (const argv of [['claim', 'bulk-export'], ['report', 'bulk-export', '--phase', 'PLANNED'], ['release', 'bulk-export']]) {
    const r = await cli(c, argv);
    assert.equal(r.code, 1, argv.join(' '));
    assert.match(r.err, /not on main/);
  }
});

test('argv is validated before use', async () => {
  const c = makeBoard().clone('c');
  assert.equal((await cli(c, ['claim', '../etc'])).code, 2);
  assert.equal((await cli(c, ['answer', 'nope', '--choice', 'confirm'])).code, 2);
  assert.equal((await cli(c, ['report', 'x', '--phase', 'DONE'])).code, 2);
  assert.equal((await cli(c, ['bogus'])).code, 2);
});

test('answer touches only the request file; second answer exits non-zero', async () => {
  const b = makeBoard();
  const id = '202606010900-abc123';
  b.seed(`board/requests/${id}.md`, request(id));
  const c = b.clone('c');
  const r = await cli(c, ['answer', id, '--choice', 'confirm', '--note', 'ok']);
  assert.equal(r.code, 0, r.err);
  assert.equal(git(b.remote, 'show', '--name-only', '--format=', 'main').trim(), `board/requests/${id}.md`);
  const fm = parseDoc(readFileSync(join(c, `board/requests/${id}.md`), 'utf8')).data;
  assert.equal(fm.answered_via, 'cli');
  assert.equal(fm.answered_by, 'lidorl');
  const again = await cli(c, ['answer', id, '--choice', 'confirm']);
  assert.equal(again.code, 1);
});

test('answer takes review-gate choices as F1=fix,F2=accept', async () => {
  const b = makeBoard();
  const id = '202606010900-abc123';
  b.seed(`board/requests/${id}.md`, request(id, {
    kind: 'gate', gate: 'review-findings', blocking: true,
    sections: { Request: 'r', Context: 'c', Findings: '### F1\nx\n\n### F2\ny' },
  }));
  const c = b.clone('c');
  const r = await cli(c, ['answer', id, '--choice', 'F1=fix,F2=accept']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(parseDoc(readFileSync(join(c, `board/requests/${id}.md`), 'utf8')).data.answer, { F1: 'fix', F2: 'accept' });
});

test('answer for a withdrawn request: "no such open request", exit 1', async () => {
  const b = makeBoard();
  const c = b.clone('c');
  const r = await cli(c, ['answer', '202606010900-abc123', '--choice', 'confirm']);
  assert.equal(r.code, 1);
  assert.match(r.err, /no such open request 202606010900-abc123/);
});

test('answer without --choice off a terminal is a usage error', async () => {
  const b = makeBoard();
  const id = '202606010900-abc123';
  b.seed(`board/requests/${id}.md`, request(id));
  assert.equal((await cli(b.clone('c'), ['answer', id])).code, 2);
});

test('inbox shows mine + approvers, oldest first; --all shows everyone', async () => {
  const b = makeBoard();
  b.seed('board/requests/202606010900-aaaaaa.md', request('202606010900-aaaaaa', { for: 'lidorl', now: hours(2) }));
  b.seed('board/requests/202606010800-bbbbbb.md', request('202606010800-bbbbbb', { for: 'approvers', now: hours(1) }));
  b.seed('board/requests/202606010700-cccccc.md', request('202606010700-cccccc', { for: 'other', now: hours(0) }));
  const c = b.clone('c');
  const mine = JSON.parse((await cli(c, ['inbox', '--json'])).out);
  assert.deepEqual(mine.map((r) => r.id), ['202606010800-bbbbbb', '202606010900-aaaaaa']);
  const all = JSON.parse((await cli(c, ['inbox', '--all', '--json'])).out);
  assert.deepEqual(all.map((r) => r.id), ['202606010700-cccccc', '202606010800-bbbbbb', '202606010900-aaaaaa']);
});

test('status renders three tables; --json is one document', async () => {
  const b = makeBoard({ featReqs: { 'bulk-export': feat() } });
  const c = b.clone('c');
  await cli(c, ['claim', 'bulk-export']);
  const r = await cli(c, ['status']);
  assert.match(r.out, /Workers\n[\s\S]*Inbox\n[\s\S]*In flight\n[\s\S]*bulk-export/);
  assert.deepEqual(Object.keys(JSON.parse((await cli(c, ['status', '--json'])).out)).sort(), ['inFlight', 'inbox', 'workers']);
});

test('watch --json --max-polls 2 prints each new event as one JSON line', async () => {
  const b = makeBoard({ featReqs: { 'bulk-export': feat() } });
  const c = b.clone('c');
  const o = b.clone('o');
  let slept = 0;
  const r = await cli(c, ['watch', '--json', '--max-polls', '2', '--interval', '1s'], {
    sleep: async (ms) => {
      slept++;
      assert.equal(ms, 1000);
      await cli(o, ['claim', 'bulk-export'], { whoami: () => ({ ...ME, login: 'other' }) });
    },
  });
  assert.equal(r.code, 0, r.err);
  assert.equal(slept, 1);
  const lines = r.out.trim().split('\n');
  assert.equal(lines.length, 1);
  const e = JSON.parse(lines[0]);
  assert.equal(e.kind, 'claim');
  assert.equal(e.effort, 'bulk-export');
});

test('reportPaths gathers the effort docs, changed history, and extras', () => {
  const b = makeBoard({ featReqs: { 'bulk-export': feat(), other: feat() } });
  const c = b.clone('c');
  mkdirSync(join(c, 'docs/plans'), { recursive: true });
  mkdirSync(join(c, 'docs/history'), { recursive: true });
  writeFileSync(join(c, 'docs/plans/bulk-export-2.md'), 'p');
  writeFileSync(join(c, 'docs/plans/other.md'), 'p');
  writeFileSync(join(c, 'docs/history/2026-06-01_bulk-export.md'), 'h');
  writeFileSync(join(c, 'docs/history/2026-06-01_other.md'), 'h');
  writeFileSync(join(c, 'notes.txt'), 'n');
  assert.deepEqual(reportPaths(c, 'bulk-export', ['notes.txt']), [
    'docs/feat-req/bulk-export.md', 'docs/plans/bulk-export-2.md', 'docs/history/2026-06-01_bulk-export.md', 'notes.txt',
  ]);
  assert.throws(() => reportPaths(c, 'bulk-export', ['../x']));
});

test('worker subcommand before Plan 2 exits 2 with a clear message', async () => {
  const c = makeBoard().clone('c');
  const r = await cli(c, ['worker', 'list']);
  assert.equal(r.code, 2);
  assert.match(r.err, /workers arrive in a later release/);
});

test('answer on a terminal with no --choice asks through the menu', async () => {
  const b = makeBoard();
  const id = '202606010900-abc123';
  b.seed(`board/requests/${id}.md`, request(id));
  const c = b.clone('c');
  const ui = { select: async ({ choices }) => choices.find((x) => x.value === 'confirm').value };
  const r = await cli(c, ['answer', id], { interactive: true, ui });
  assert.equal(r.code, 0, r.err);
  assert.equal(parseDoc(readFileSync(join(c, `board/requests/${id}.md`), 'utf8')).data.answer, 'confirm');
});

test('reportPaths: efforts `bulk` and `bulk-export` side by side do not take each other\'s files', () => {
  const b = makeBoard({ featReqs: { bulk: feat(), 'bulk-export': feat() } });
  const c = b.clone('c');
  mkdirSync(join(c, 'docs/plans'), { recursive: true });
  mkdirSync(join(c, 'docs/history'), { recursive: true });
  for (const f of ['bulk.md', 'bulk-2.md', 'bulk-export.md', 'bulk-export-2.md', 'bulk-notes.md']) writeFileSync(join(c, 'docs/plans', f), 'p');
  for (const f of ['2026-06-01_bulk.md', '2026-06-02_bulk-3.md', '2026-06-01_bulk-export.md']) writeFileSync(join(c, 'docs/history', f), 'h');
  assert.deepEqual(reportPaths(c, 'bulk'), [
    'docs/feat-req/bulk.md', 'docs/plans/bulk-2.md', 'docs/plans/bulk.md',
    'docs/history/2026-06-01_bulk.md', 'docs/history/2026-06-02_bulk-3.md',
  ]);
});

test('report --paths refuses board/ files and other efforts\' docs (exit 2)', async () => {
  const b = makeBoard({ featReqs: { 'bulk-export': feat(), other: feat() } });
  const c = b.clone('c');
  await cli(c, ['claim', 'bulk-export']);
  for (const p of ['board/config.yml', 'board/requests/x.md', './board/workers/a.yml', 'docs/feat-req/other.md', 'docs/feat-req/../../board/config.yml']) {
    const r = await cli(c, ['report', 'bulk-export', '--phase', 'PLANNED', '--paths', p]);
    assert.equal(r.code, 2, p);
  }
  assert.equal(git(b.remote, 'log', '--format=%s', 'main').split('\n').filter((l) => l.startsWith('board(report)')).length, 0);
});

test('watch --since must be a hex sha (no git option injection)', async () => {
  const c = makeBoard().clone('c');
  const r = await cli(c, ['watch', '--max-polls', '1', '--since=--output=../x']);
  assert.equal(r.code, 2);
});

test('a whoami that cannot find a GitHub login stops with the fix and pushes nothing', async () => {
  const b = makeBoard({ featReqs: { 'bulk-export': feat() } });
  const c = b.clone('c');
  const before = git(b.remote, 'rev-parse', 'main');
  const whoami = () => { throw new Error('cannot determine your GitHub login: run `gh auth login`, then try again'); };
  for (const argv of [['claim', 'bulk-export'], ['report', 'bulk-export', '--phase', 'PLANNED'], ['inbox']]) {
    const r = await cli(c, argv, { whoami });
    assert.equal(r.code, 1, argv.join(' '));
    assert.match(r.err, /run `gh auth login`/);
  }
  assert.equal(git(b.remote, 'rev-parse', 'main'), before);
});

test('report that lands but is then replaced by a takeover exits 3 and keeps the new design doc on disk', async () => {
  const b = makeBoard({ featReqs: { 'bulk-export': feat() } });
  const a = b.clone('a');
  const o = b.clone('o');
  assert.equal((await cli(a, ['claim', 'bulk-export'])).code, 0);
  git(o, 'pull', '-q', '--ff-only', 'origin', 'main');
  mkdirSync(join(a, 'docs/design'), { recursive: true });
  writeFileSync(join(a, 'docs/design/bulk-export.md'), '# my design\n');
  let fired = false;
  const hooks = {
    beforePush: () => {
      if (fired) return;
      fired = true;
      const f = join(o, 'docs/feat-req/bulk-export.md');
      writeFileSync(f, readFileSync(f, 'utf8').replace('claimed_by: lidorl', 'claimed_by: lidorl-1a2b3c'));
      git(o, 'commit', '-qam', 'board(takeover): bulk-export');
      git(o, 'push', '-q', 'origin', 'main');
    },
  };
  const r = await cli(a, ['report', 'bulk-export', '--phase', 'DESIGNED'], { now: hours(1), hooks });
  assert.equal(r.code, 3, r.err);
  assert.match(r.err, /lidorl-1a2b3c/);
  assert.equal(readFileSync(join(a, 'docs/design/bulk-export.md'), 'utf8'), '# my design\n');
  assert.equal(git(a, 'rev-parse', 'HEAD'), git(a, 'rev-parse', 'origin/main'));
});

test('report whose takeover conflicts exits 3, keeps only the design doc, and a second report pushes nothing', async () => {
  const b = makeBoard({ featReqs: { 'bulk-export': feat() } });
  b.seed('other.md', 'x\n');
  const a = b.clone('a');
  const o = b.clone('o');
  assert.equal((await cli(a, ['claim', 'bulk-export'])).code, 0);
  git(o, 'pull', '-q', '--ff-only', 'origin', 'main');
  mkdirSync(join(a, 'docs/design'), { recursive: true });
  writeFileSync(join(a, 'docs/design/bulk-export.md'), '# my design\n');
  let fired = false;
  const hooks = {
    beforePush: () => {
      if (fired) return;
      fired = true;
      const f = join(o, 'docs/feat-req/bulk-export.md');
      writeFileSync(f, readFileSync(f, 'utf8').replace('claimed_by: lidorl', 'claimed_by: lidorl-1a2b3c').replace(/renewed_at: .*/, 'renewed_at: 2026-06-01T10:30:00Z'));
      writeFileSync(join(o, 'other.md'), 'changed\n');
      git(o, 'commit', '-qam', 'board(takeover): bulk-export');
      git(o, 'push', '-q', 'origin', 'main');
    },
  };
  const r = await cli(a, ['report', 'bulk-export', '--phase', 'DESIGNED'], { now: hours(1), hooks });
  assert.equal(r.code, 3, r.err);
  assert.match(r.err, /kept your uncommitted work: docs\/design\/bulk-export\.md/);
  assert.equal(git(a, 'status', '--porcelain').trim(), '?? docs/design/');
  const tip = git(b.remote, 'rev-parse', 'main');
  const again = await cli(a, ['report', 'bulk-export', '--phase', 'DESIGNED'], { now: hours(2) });
  assert.equal(again.code, 3, again.err);
  assert.match(again.err, /held by lidorl-1a2b3c/);
  assert.equal(git(b.remote, 'rev-parse', 'main'), tip);
});
