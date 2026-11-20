import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeBoard, IDENT } from '../board/fixtures.mjs';
import { workerYaml } from '../board/registry.mjs';
import { buildRequest, answerRequest, validateRequest } from '../board/requests.mjs';
import { parseDoc } from '../board/frontmatter.mjs';
import { runAgent } from './agent.mjs';
import { writeConfig, readState, writeState } from './home.mjs';
import { assemble } from '../../assemble-env.mjs';
import { makeContext, step } from './loop.mjs';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-agent.mjs');
const T0 = new Date('2026-06-01T10:00:00Z');
const at = (ms) => new Date(T0.getTime() + ms);
const MIN = 60e3;
const OWNER = { name: 'Alice Owner', email: 'alice@users.noreply.github.com' };
const IDA = 'alice-aaaaaa';
const IDB = 'alice-bbbbbb';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const feat = (extra = {}) => ({ status: 'ACCEPTED', priority: 'high', date: '2026-05-01', ...extra });
const design = (repos) => `---\nstatus: APPROVED\nrepos: [${repos.join(', ')}]\n---\n\n# design\n`;
const onMain = (b, path) => { try { return git(b.remote, 'show', `main:${path}`); } catch { return null; } };
const fmOnMain = (b, slug) => parseDoc(onMain(b, `docs/feat-req/${slug}.md`)).data;
const tip = (b) => git(b.remote, 'rev-parse', 'main').trim();
const headMsg = (b) => git(b.remote, 'log', '-1', '--format=%B', 'main');
const requestsOnMain = (b) => git(b.remote, 'ls-tree', '--name-only', 'main', 'board/requests/')
  .split('\n').filter((p) => p.endsWith('.md')).map((p) => ({ path: p, text: onMain(b, p) }));
const completed = (phase, extra = {}) => ({ outcome: 'completed', phase, summary: `reached ${phase}`, ...extra });

const reg = (id) => workerYaml({
  id, owner: 'alice', name: id, host: 'h', agent: 'claude', model: 'opus', created_at: '2026-01-01T00:00:00Z',
});

function setup({ featReqs = {}, files = {}, config, workers = [IDA] } = {}) {
  const all = { '.gitignore': 'workspace/\n', ...files };
  for (const id of workers) all[`board/workers/${id}.yml`] = reg(id);
  if (config) all['board/config.yml'] = config;
  return makeBoard({ featReqs, files: all });
}

// A code repo: bare remote with one commit on main.
function codeRepo(b, name = 'api') {
  const remote = join(b.dir, `${name}.git`);
  git(b.dir, 'init', '--bare', '-q', '-b', 'main', remote);
  const seed = join(b.dir, `${name}-seed`);
  git(b.dir, 'clone', '-q', remote, seed);
  git(seed, 'checkout', '-q', '-B', 'main');
  git(seed, 'config', 'user.name', IDENT.name);
  git(seed, 'config', 'user.email', IDENT.email);
  writeFileSync(join(seed, 'README.md'), `# ${name}\n`);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'init');
  git(seed, 'push', '-q', 'origin', 'main');
  return { remote, seed, catalog: { [name]: { url: remote, default_branch: 'main', readonly: false } } };
}

// A worker home with its meta clone, a scripted fake agent and test deps.
function worker(b, { id = IDA, script = { result: null }, catalog = {}, clock, deps = {} } = {}) {
  const home = join(b.dir, `home-${id}`);
  b.clone(`home-${id}/meta`);
  writeConfig(home, {
    id, owner: 'alice', meta_url: b.remote, agent: 'claude', model: 'opus', cli_args: [], name: id, author: OWNER,
  });
  const scriptPath = join(home, 'fake-script.json');
  const w = { id, home, meta: join(home, 'meta'), logs: [], runs: [], now: T0, beforeRun: null };
  w.script = (s) => writeFileSync(scriptPath, JSON.stringify(s));
  w.script(script);
  const all = {
    now: clock ?? (() => w.now),
    sleep: async () => {},
    gh: { installed: () => true, authOk: () => true },
    which: () => true,
    log: (m) => w.logs.push(m),
    runAgent: async (opts) => {
      w.runs.push(opts);
      if (w.beforeRun) await w.beforeRun(opts);
      return runAgent({ ...opts, cmd: process.execPath, args: [FAKE], env: { ...opts.env, FAKE_AGENT_SCRIPT: scriptPath } });
    },
    assemble: (opts) => assemble({ ...opts, catalog: { repos: catalog } }),
    ...deps,
  };
  w.restart = () => { w.ctx = makeContext({ home, deps: all }); };
  w.restart();
  w.step = () => step(w.ctx);
  w.prompt = (i = w.runs.length - 1) => w.runs[i].args[1];
  return w;
}

// Every commit message on main since `from`.
const messagesSince = (b, from) => git(b.remote, 'log', '--format=%B%x00', `${from}..main`).split('\0').map((s) => s.trim()).filter(Boolean);

test('ACCEPTED effort: claim → run → report with Phase trailer and renewed lease', async () => {
  const b = setup({ featReqs: { alpha: feat() } });
  const w = worker(b, {
    script: { writes: { 'docs/design/alpha.md': design(['api']) }, result: completed('ACCEPTED') },
  });
  w.beforeRun = () => { w.now = at(60 * MIN); };
  const r = await w.step();
  assert.deepEqual(r, { action: 'reported', effort: 'alpha' });
  assert.match(w.prompt(), /\/classify-change then \/write-design-doc/);
  const msg = headMsg(b);
  assert.match(msg, /^board\(report\): alpha/);
  assert.match(msg, /Worker: alice-aaaaaa\nSdlc-Event: report\nEffort: alpha\nPhase: ACCEPTED/);
  const fm = fmOnMain(b, 'alpha');
  assert.equal(fm.claimed_by, IDA);
  assert.equal(fm.claimed_at, '2026-06-01T10:00:00Z');
  assert.equal(fm.renewed_at, '2026-06-01T11:00:00Z');
  assert.equal(onMain(b, 'docs/design/alpha.md'), design(['api']));
  assert.equal(readState(w.home).failures, 0);
});

test('every commit (meta and code repo) has Worker trailer and owner author', async () => {
  const b = setup({ featReqs: { alpha: feat({ status: 'DESIGNED' }) }, files: { 'docs/design/alpha.md': design(['api']) } });
  const code = codeRepo(b);
  const seedSha = tip(b);
  const w = worker(b, {
    catalog: code.catalog,
    script: {
      writes: { 'workspace/api/feature.txt': 'x\n', 'docs/plans/alpha.md': '---\nstatus: PLANNED\n---\n\n- [ ] Step 1\n' },
      exec: [['workspace/api', 'git', 'add', 'feature.txt'], ['workspace/api', 'git', 'commit', '-q', '-m', 'add feature']],
      result: completed('PLANNED'),
    },
  });
  assert.equal((await w.step()).action, 'reported');
  const meta = git(b.remote, 'log', '--format=%an|%(trailers:key=Worker,valueonly,separator=)', `${seedSha}..main`).trim().split('\n');
  assert.ok(meta.length >= 2, meta.join('\n'));
  for (const line of meta) assert.equal(line, `${OWNER.name}|${IDA}`);
  const codeLog = git(code.remote, 'log', '--format=%an|%(trailers:key=Worker,valueonly,separator=)', 'main..feat/alpha').trim().split('\n');
  assert.deepEqual(codeLog, [`${OWNER.name}|${IDA}`]);
});

test('blocking request: one commit posts it, sets awaiting, releases; next step picks other work', async () => {
  const b = setup({ featReqs: { alpha: feat(), beta: feat({ priority: 'low' }) } });
  const w = worker(b, {
    script: {
      writes: { 'docs/design/alpha.md': design(['api']) },
      result: {
        outcome: 'request',
        request: { kind: 'gate', gate: 'design-approval', for: 'owner', blocking: true, sections: { Request: 'Approve the design', Context: 'docs/design/alpha.md' } },
      },
    },
  });
  const r = await w.step();
  assert.deepEqual(r, { action: 'requested', effort: 'alpha' });
  const reqs = requestsOnMain(b);
  assert.equal(reqs.length, 1);
  const id = parseDoc(reqs[0].text).data.id;
  assert.deepEqual(validateRequest(reqs[0].text, `${id}.md`), []);
  const rfm = parseDoc(reqs[0].text).data;
  assert.equal(rfm.for, 'alice');
  assert.equal(rfm.worker, IDA);
  const files = git(b.remote, 'show', '--name-only', '--format=', 'main').trim().split('\n').sort();
  assert.deepEqual(files, [`board/requests/${id}.md`, 'docs/feat-req/alpha.md']);
  assert.match(headMsg(b), /^board\(request\): /);
  const fm = fmOnMain(b, 'alpha');
  assert.equal(fm.awaiting, id);
  assert.equal(fm.claimed_by, undefined);
  assert.equal(onMain(b, 'docs/design/alpha.md'), design(['api']), 'the draft the gate asks about is on main');

  w.script({ result: completed('ACCEPTED') });
  assert.deepEqual(await w.step(), { action: 'reported', effort: 'beta' });
  assert.match(w.prompt(), /effort beta/);
});

test('clarification: posted, claim kept, run continues next step', async () => {
  const b = setup({ featReqs: { alpha: feat() } });
  const w = worker(b, {
    script: {
      result: {
        outcome: 'request',
        request: { kind: 'clarification', blocking: false, sections: { Request: 'Assumed CSV', Context: 'export format', Assumption: 'CSV' } },
      },
    },
  });
  assert.deepEqual(await w.step(), { action: 'requested', effort: 'alpha' });
  const reqs = requestsOnMain(b);
  assert.equal(reqs.length, 1);
  assert.equal(parseDoc(reqs[0].text).data.kind, 'clarification');
  const fm = fmOnMain(b, 'alpha');
  assert.equal(fm.claimed_by, IDA);
  assert.equal(fm.awaiting, undefined);

  w.script({ result: completed('ACCEPTED') });
  assert.deepEqual(await w.step(), { action: 'reported', effort: 'alpha' });
  assert.equal(w.runs.length, 2);
});

test('agent exit 1 / no result file / timeout → effort error with redacted excerpt, release, backoff set', async () => {
  const b = setup({
    featReqs: { alpha: feat(), beta: feat({ priority: 'medium' }), gamma: feat({ priority: 'low' }) },
    config: 'phase_timeout: 1s\n',
  });
  const token = `ghp_${'a'.repeat(36)}`;
  const w = worker(b, { script: { stderr: `boom: token ${token}`, exitCode: 1, result: null } });

  const errorFor = (slug) => {
    const fm = fmOnMain(b, slug);
    assert.equal(fm.claimed_by, undefined, `${slug} released`);
    const text = onMain(b, `board/requests/${fm.awaiting}.md`);
    assert.ok(text, `${slug} awaits its error request`);
    assert.deepEqual(validateRequest(text, `${fm.awaiting}.md`), []);
    const rq = parseDoc(text).data;
    assert.equal(rq.kind, 'error');
    assert.equal(rq.scope, 'effort');
    assert.equal(rq.blocking, true);
    assert.equal(rq.for, 'alice');
    return text;
  };

  assert.deepEqual(await w.step(), { action: 'failed', effort: 'alpha' });
  const text = errorFor('alpha');
  assert.match(text, /boom: token \[REDACTED\]/);
  assert.ok(!text.includes(token));
  assert.deepEqual(readState(w.home), { clean_stop: true, failures: 1, backoff_until: at(5 * MIN).toISOString() });

  w.now = at(6 * MIN);
  w.script({ result: null });
  assert.deepEqual(await w.step(), { action: 'failed', effort: 'beta' });
  assert.match(errorFor('beta'), /result file missing/);
  assert.equal(readState(w.home).failures, 2);
  assert.equal(readState(w.home).backoff_until, at(21 * MIN).toISOString());

  w.now = at(22 * MIN);
  w.script({ sleepMs: 4000, result: completed('ACCEPTED') });
  assert.deepEqual(await w.step(), { action: 'failed', effort: 'gamma' });
  assert.match(errorFor('gamma'), /timed out/);
  assert.equal(readState(w.home).failures, 3);
  assert.equal(readState(w.home).backoff_until, at(82 * MIN).toISOString());
});

test('backoff: no claim while now < backoff_until', async () => {
  const b = setup({ featReqs: { alpha: feat() } });
  const w = worker(b, { script: { result: completed('ACCEPTED') } });
  writeState(w.home, { failures: 1, backoff_until: at(5 * MIN).toISOString() });
  const before = tip(b);
  assert.deepEqual(await w.step(), { action: 'idle' });
  assert.equal(tip(b), before);
  assert.equal(w.runs.length, 0);
  w.now = at(5 * MIN + 1000);
  assert.deepEqual(await w.step(), { action: 'reported', effort: 'alpha' });
  assert.deepEqual(readState(w.home), { clean_stop: true, failures: 0, backoff_until: null });
});

test('model-not-found stderr → worker error, needs-attention, no claim until answered resolved', async () => {
  const b = setup({ featReqs: { alpha: feat() } });
  const w = worker(b, { script: { stderr: 'Error: model "opus" not found', exitCode: 1, result: null } });
  assert.deepEqual(await w.step(), { action: 'needs-attention' });
  const reqs = requestsOnMain(b);
  assert.equal(reqs.length, 1);
  const rq = parseDoc(reqs[0].text).data;
  assert.equal(rq.scope, 'worker');
  assert.equal(rq.worker, IDA);
  assert.equal(rq.kind, 'error');
  assert.deepEqual(validateRequest(reqs[0].text, `${rq.id}.md`), []);
  const fm = fmOnMain(b, 'alpha');
  assert.equal(fm.claimed_by, undefined, 'the effort is released for others');
  assert.equal(fm.awaiting, undefined, 'the effort does not wait on a worker error');

  const before = tip(b);
  assert.deepEqual(await w.step(), { action: 'needs-attention' });
  assert.equal(tip(b), before, 'no claim while the worker error is open');
  assert.equal(w.runs.length, 1);

  const p = b.clone('p');
  assert.equal((await answerRequest(p, rq.id, { answer: 'resolved', by: 'alice', identity: OWNER, now: T0 })).ok, true);
  w.script({ result: completed('ACCEPTED') });
  assert.deepEqual(await w.step(), { action: 'reported', effort: 'alpha' });
  assert.equal(requestsOnMain(b).length, 0);
});

test('taken over between steps → action lost, nothing pushed for that effort', async () => {
  const b = setup({ featReqs: { alpha: feat() } });
  const w = worker(b, {
    script: { result: { outcome: 'request', request: { kind: 'clarification', blocking: false, sections: { Request: 'r', Context: 'c', Assumption: 'a' } } } },
  });
  assert.equal((await w.step()).action, 'requested');
  const f = onMain(b, 'docs/feat-req/alpha.md');
  b.seed('docs/feat-req/alpha.md', f.replace(`claimed_by: ${IDA}`, 'claimed_by: bob-zzzzzz'), 'board(takeover): alpha');
  const before = tip(b);
  w.script({ writes: { 'docs/design/alpha.md': design(['api']) }, result: completed('ACCEPTED') });
  assert.deepEqual(await w.step(), { action: 'lost', effort: 'alpha' });
  assert.equal(tip(b), before);
  assert.equal(w.runs.length, 1, 'no agent run for a lost effort');
  assert.ok(w.logs.some((l) => /alpha/.test(l) && /bob-zzzzzz/.test(l)), w.logs.join('\n'));
});

test('person parks the effort mid-hold → lost, nothing pushed', async () => {
  const b = setup({ featReqs: { alpha: feat({ status: 'DESIGNED' }) }, files: { 'docs/design/alpha.md': design(['api']) } });
  const code = codeRepo(b);
  const w = worker(b, {
    catalog: code.catalog,
    script: {
      writes: { 'workspace/api/f.txt': 'x\n', 'docs/plans/alpha.md': '# plan\n' },
      exec: [['workspace/api', 'git', 'add', 'f.txt'], ['workspace/api', 'git', 'commit', '-q', '-m', 'wip']],
      result: completed('PLANNED'),
    },
  });
  w.beforeRun = () => {
    const f = onMain(b, 'docs/feat-req/alpha.md');
    b.seed('docs/feat-req/alpha.md', f.replace('status: DESIGNED', 'status: PARKED'), 'park alpha');
  };
  assert.deepEqual(await w.step(), { action: 'lost', effort: 'alpha' });
  assert.match(git(b.remote, 'log', '-1', '--format=%s', 'main'), /^park alpha/);
  assert.equal(onMain(b, 'docs/plans/alpha.md'), null);
  assert.equal(git(code.remote, 'branch', '--list', 'feat/alpha').trim(), '', 'code branch not pushed');
});

test('code branch feat/<slug> pushed before report; dirty code repo named in report body', async () => {
  const b = setup({ featReqs: { alpha: feat({ status: 'DESIGNED' }) }, files: { 'docs/design/alpha.md': design(['api']) } });
  const code = codeRepo(b);
  const seen = [];
  const w = worker(b, {
    catalog: code.catalog,
    script: {
      writes: { 'workspace/api/f.txt': 'x\n', 'workspace/api/scratch.txt': 'not committed\n', 'docs/plans/alpha.md': '# plan\n' },
      exec: [['workspace/api', 'git', 'add', 'f.txt'], ['workspace/api', 'git', 'commit', '-q', '-m', 'feature']],
      result: completed('PLANNED'),
    },
    deps: { hooks: { beforePush: () => { seen.push(git(code.remote, 'branch', '--list', 'feat/alpha').trim()); } } },
  });
  assert.deepEqual(await w.step(), { action: 'reported', effort: 'alpha' });
  assert.equal(seen.at(-1), 'feat/alpha', 'the code branch was on its remote when the report was pushed');
  assert.equal(git(code.remote, 'rev-parse', 'feat/alpha').trim(), git(join(w.meta, 'workspace/api'), 'rev-parse', 'HEAD').trim());
  const msg = headMsg(b);
  assert.match(msg, /^board\(report\): alpha/);
  assert.match(msg, /workspace\/api has uncommitted changes/);
});

test('stray edit to CLAUDE.process.md is not committed, is logged as a warning, and stays on disk (Ruling P2-2)', async () => {
  const b = setup({ featReqs: { alpha: feat(), beta: feat({ priority: 'low' }) }, files: { 'CLAUDE.process.md': 'contract\n' } });
  const w = worker(b, {
    script: {
      writes: { 'CLAUDE.process.md': 'edited by agent\n', 'docs/design/alpha.md': design(['api']) },
      result: completed('ACCEPTED'),
    },
  });
  assert.deepEqual(await w.step(), { action: 'reported', effort: 'alpha' });
  assert.equal(onMain(b, 'CLAUDE.process.md'), 'contract\n');
  assert.equal(onMain(b, 'docs/design/alpha.md'), design(['api']));
  assert.ok(w.logs.some((l) => /warning/.test(l) && /CLAUDE\.process\.md/.test(l)), w.logs.join('\n'));
  assert.equal(readFileSync(join(w.meta, 'CLAUDE.process.md'), 'utf8'), 'edited by agent\n');

  w.script({ result: completed('ACCEPTED') });
  assert.equal((await w.step()).action, 'reported');
  assert.equal(onMain(b, 'CLAUDE.process.md'), 'contract\n');
});

test('remote unreachable → idle with a log line, no worker error posted', async () => {
  const b = setup({ featReqs: { alpha: feat() } });
  const w = worker(b, { script: { result: completed('ACCEPTED') } });
  git(w.meta, 'remote', 'set-url', 'origin', join(b.dir, 'nowhere.git'));
  const before = tip(b);
  assert.deepEqual(await w.step(), { action: 'idle' });
  assert.equal(tip(b), before);
  assert.equal(w.runs.length, 0);
  assert.ok(w.logs.some((l) => /origin/.test(l)), w.logs.join('\n'));
});

test('empty queue → idle, zero commits pushed', async () => {
  const b = setup({ featReqs: { done: feat({ status: 'IMPLEMENTED' }), later: feat({ status: 'PARKED' }) } });
  const w = worker(b);
  const before = tip(b);
  assert.deepEqual(await w.step(), { action: 'idle' });
  assert.deepEqual(await w.step(), { action: 'idle' });
  assert.equal(tip(b), before);
  assert.equal(w.runs.length, 0);
});

test('idle step applies answered clarifications on IMPLEMENTED efforts (Ruling P2-1)', async () => {
  const id = '202606010900-cccccc';
  const req = buildRequest({
    id, kind: 'clarification', scope: 'effort', effort: 'done', worker: IDB, for: 'alice', blocking: false, now: T0,
    sections: { Request: 'Assumed CSV', Context: 'c', Assumption: 'CSV' },
  });
  const b = setup({ featReqs: { done: feat({ status: 'IMPLEMENTED' }) }, files: { [`board/requests/${id}.md`]: req } });
  assert.equal((await answerRequest(b.clone('p'), id, { answer: 'correct', notes: 'use JSON', by: 'alice', identity: OWNER, now: T0 })).ok, true);
  const w = worker(b);
  assert.deepEqual(await w.step(), { action: 'idle' });
  assert.equal(onMain(b, `board/requests/${id}.md`), null);
  assert.equal(fmOnMain(b, `done-followup-${id}`).status, 'ACCEPTED');
  assert.match(git(b.remote, 'log', '-1', '--format=%B', 'main'), /^board\(apply\): closed[\s\S]*Worker: alice-aaaaaa/);
});

test('answered clarification on held effort → rework step added before next run', async () => {
  const b = setup({
    featReqs: { alpha: feat({ status: 'IN_PROGRESS' }) },
    files: { 'docs/plans/alpha.md': '---\nstatus: IN_PROGRESS\n---\n\n- [x] Step 1\n- [ ] Step 2\n' },
  });
  const w = worker(b, {
    script: { result: { outcome: 'request', request: { kind: 'clarification', blocking: false, sections: { Request: 'Assumed v1', Context: 'c', Assumption: 'v1 API' } } } },
  });
  assert.equal((await w.step()).action, 'requested');
  const id = parseDoc(requestsOnMain(b)[0].text).data.id;
  assert.equal((await answerRequest(b.clone('p'), id, { answer: 'correct', notes: 'use the v2 API', by: 'alice', identity: OWNER, now: T0 })).ok, true);
  let planAtRun = null;
  w.beforeRun = () => { planAtRun = readFileSync(join(w.meta, 'docs/plans/alpha.md'), 'utf8'); };
  w.script({ result: completed('IN_PROGRESS') });
  assert.equal((await w.step()).action, 'reported');
  assert.match(planAtRun, /- \[x\] Step 1\n- \[ \] Rework \(clarification \d{12}-[a-z0-9]{6}\): use the v2 API\n- \[ \] Step 2/);
  assert.equal(requestsOnMain(b).length, 0);
});

test('lease renewed during a run longer than ttl/2; no renew when the run is short', async () => {
  const b = setup({ featReqs: { alpha: feat() }, config: 'lease_ttl: 2s\n' });
  const start = Date.now();
  const w = worker(b, { clock: () => at(Date.now() - start), script: { sleepMs: 1700, result: completed('ACCEPTED') } });
  const renews = () => git(b.remote, 'log', '--format=%s', 'main').split('\n').filter((s) => s === 'board(renew): alpha').length;
  assert.equal((await w.step()).action, 'reported');
  assert.ok(renews() >= 1, 'a long run renews the lease');
  const after = renews();
  w.script({ result: completed('ACCEPTED') });
  assert.equal((await w.step()).action, 'reported');
  assert.equal(renews(), after, 'a short run pushes no renew');
});

test('two workers with separate homes on one machine, steps interleaved: different efforts, no shared files', async () => {
  const b = setup({ featReqs: { alpha: feat(), beta: feat({ priority: 'low' }) }, workers: [IDA, IDB] });
  const a = worker(b, { id: IDA, script: { result: completed('ACCEPTED') } });
  const c = worker(b, { id: IDB, script: { result: completed('ACCEPTED') } });
  assert.deepEqual(await a.step(), { action: 'reported', effort: 'alpha' });
  assert.deepEqual(await c.step(), { action: 'reported', effort: 'beta' });
  assert.deepEqual(await a.step(), { action: 'reported', effort: 'alpha' });
  assert.deepEqual(await c.step(), { action: 'reported', effort: 'beta' });
  assert.equal(fmOnMain(b, 'alpha').claimed_by, IDA);
  assert.equal(fmOnMain(b, 'beta').claimed_by, IDB);
  for (const [w, other] of [[a, c], [c, a]]) {
    for (const run of w.runs) {
      assert.ok(run.cwd.startsWith(w.home) && run.logPath.startsWith(w.home) && run.env.SDLC_RESULT_FILE.startsWith(w.home));
      assert.ok(!run.logPath.startsWith(other.home));
    }
  }
  assert.equal(readdirSync(join(a.home, 'logs/runs')).length, 2);
  assert.equal(readdirSync(join(c.home, 'logs/runs')).length, 2);
});

test('takeover of a stale IN_PROGRESS effort: workspace built from origin/feat/<slug>, prompt says resume from first unchecked step', async () => {
  const b = setup({
    featReqs: { alpha: feat({ status: 'IN_PROGRESS', claimed_by: 'bob-zzzzzz', claimed_at: '2026-06-01T04:00:00Z', renewed_at: '2026-06-01T05:00:00Z' }) },
    files: { 'docs/design/alpha.md': design(['api']), 'docs/plans/alpha.md': '---\nstatus: IN_PROGRESS\n---\n\n- [x] one\n- [ ] two\n' },
  });
  const code = codeRepo(b);
  git(code.seed, 'checkout', '-q', '-b', 'feat/alpha');
  writeFileSync(join(code.seed, 'wip.txt'), 'bob was here\n');
  git(code.seed, 'add', '-A');
  git(code.seed, 'commit', '-q', '-m', 'wip');
  git(code.seed, 'push', '-q', 'origin', 'feat/alpha');
  const wip = git(code.seed, 'rev-parse', 'HEAD').trim();
  const w = worker(b, { catalog: code.catalog, script: { result: completed('IN_PROGRESS') } });
  let checkout = null;
  w.beforeRun = () => { checkout = git(join(w.meta, 'workspace/api'), 'rev-parse', 'HEAD').trim(); };
  assert.deepEqual(await w.step(), { action: 'reported', effort: 'alpha' });
  assert.equal(checkout, wip);
  assert.match(w.prompt(), /Resume from the plan's first unchecked step\./);
  const takeover = git(b.remote, 'log', '--format=%B%x00', 'main').split('\0').find((m) => m.trim().startsWith('board(takeover): alpha'));
  assert.match(takeover, /Replaces: bob-zzzzzz/);
});

test('overlap with another live claim: warning logged and named in the claim commit body, claim proceeds', async () => {
  const b = setup({
    featReqs: {
      alpha: feat({ status: 'DESIGNED', claimed_by: 'bob-zzzzzz', claimed_at: '2026-06-01T09:00:00Z' }),
      beta: feat({ priority: 'low' }),
    },
    files: { 'docs/design/alpha.md': design(['api']), 'docs/design/beta.md': '---\nstatus: DRAFT\nrepos: [api, web]\n---\n# b\n' },
  });
  const seedSha = tip(b);
  const w = worker(b, { script: { result: completed('ACCEPTED') } });
  assert.deepEqual(await w.step(), { action: 'reported', effort: 'beta' });
  assert.ok(w.logs.some((l) => /warning/.test(l) && /beta/.test(l) && /alpha/.test(l) && /api/.test(l)), w.logs.join('\n'));
  const claimMsg = messagesSince(b, seedSha).find((m) => m.startsWith('board(claim): beta'));
  assert.match(claimMsg, /alpha/);
  assert.match(claimMsg, /api/);
});

test('crash between apply and run: the next step reuses the persisted agent input (Ruling P2-3)', async () => {
  const id = '202606010900-qqqqqq';
  const req = buildRequest({
    id, kind: 'question', scope: 'effort', effort: 'alpha', worker: IDB, for: 'alice', blocking: true, now: T0,
    sections: { Request: 'Which format?', Context: 'c', Options: 'A) CSV\nB) JSON' },
  });
  const b = setup({ featReqs: { alpha: feat({ awaiting: id }) }, files: { [`board/requests/${id}.md`]: req } });
  assert.equal((await answerRequest(b.clone('p'), id, { answer: 'B', by: 'alice', identity: OWNER, now: T0 })).ok, true);
  const w = worker(b, { script: { result: completed('ACCEPTED') } });
  w.beforeRun = () => { throw new Error('simulated crash'); };
  await assert.rejects(w.step(), /simulated crash/);
  assert.equal(onMain(b, `board/requests/${id}.md`), null, 'the apply commit deleted the request');
  assert.ok(existsSync(join(w.home, 'run/agent-input.json')));

  w.beforeRun = null;
  w.restart();
  assert.deepEqual(await w.step(), { action: 'reported', effort: 'alpha' });
  assert.match(w.prompt(), /Option B/);
  assert.ok(!existsSync(join(w.home, 'run/agent-input.json')), 'deleted once the result is handled');
});

test('preflight worker error; once answered resolved, the worker deletes it and takes work again (Ruling P2-4)', async () => {
  const b = setup({ featReqs: { alpha: feat() } });
  let auth = false;
  const w = worker(b, { script: { result: completed('ACCEPTED') }, deps: { gh: { installed: () => true, authOk: () => auth } } });
  assert.deepEqual(await w.step(), { action: 'needs-attention' });
  assert.deepEqual(await w.step(), { action: 'needs-attention' });
  const reqs = requestsOnMain(b);
  assert.equal(reqs.length, 1, 'one open worker error per worker');
  const rq = parseDoc(reqs[0].text).data;
  assert.match(reqs[0].text, /gh is not logged in/);
  auth = true;
  assert.deepEqual(await w.step(), { action: 'needs-attention' }, 'still open: no claim');
  assert.equal(w.runs.length, 0);
  assert.equal((await answerRequest(b.clone('p'), rq.id, { answer: 'resolved', by: 'alice', identity: OWNER, now: T0 })).ok, true);
  const before = tip(b);
  assert.deepEqual(await w.step(), { action: 'reported', effort: 'alpha' });
  const first = messagesSince(b, before).at(-1); // log is newest first
  assert.match(first, /^board\(apply\): worker\n\nWorker: alice-aaaaaa\nSdlc-Event: apply$/);
  assert.equal(requestsOnMain(b).length, 0);
});

test('report after a renew during the run keeps the agent\'s edit to the line next to renewed_at', async () => {
  // Frontmatter order puts status right after renewed_at, so the agent's status edit and the renew touch adjacent lines.
  const b = setup({
    featReqs: { alpha: { priority: 'high', date: '2026-05-01', claimed_by: 'bob-zzzzzz', claimed_at: '2026-05-01T00:00:00Z', renewed_at: '2026-05-01T00:00:00Z', status: 'ACCEPTED' } },
    config: 'lease_ttl: 2s\n',
  });
  const start = Date.now();
  const w = worker(b, { clock: () => at(Date.now() - start), script: { result: null } });
  w.beforeRun = () => {
    const f = join(w.meta, 'docs/feat-req/alpha.md');
    const text = readFileSync(f, 'utf8');
    assert.match(text, /renewed_at: .*\nstatus: ACCEPTED/);
    w.script({ writes: { 'docs/feat-req/alpha.md': text.replace('status: ACCEPTED', 'status: DESIGNED') }, sleepMs: 1700, result: completed('DESIGNED') });
  };
  assert.deepEqual(await w.step(), { action: 'reported', effort: 'alpha' });
  assert.ok(git(b.remote, 'log', '--format=%s', 'main').includes('board(renew): alpha'), 'a renew landed during the run');
  const fm = fmOnMain(b, 'alpha');
  assert.equal(fm.status, 'DESIGNED');
  assert.equal(fm.claimed_by, IDA);
  assert.equal(git(w.meta, 'stash', 'list'), '');
  assert.equal(git(w.meta, 'status', '--porcelain'), '');
});

test('development_done routes to close-out; an IMPLEMENTED report releases and returns done', async () => {
  const b = setup({ featReqs: { alpha: feat({ status: 'IN_PROGRESS' }) }, files: { 'docs/plans/alpha.md': '---\nstatus: IN_PROGRESS\n---\n\n- [x] one\n' } });
  const w = worker(b, { script: { result: completed('IN_PROGRESS', { development_done: true }) } });
  assert.deepEqual(await w.step(), { action: 'reported', effort: 'alpha' });
  w.beforeRun = () => {
    const text = readFileSync(join(w.meta, 'docs/feat-req/alpha.md'), 'utf8');
    w.script({ writes: { 'docs/feat-req/alpha.md': text.replace('status: IN_PROGRESS', 'status: IMPLEMENTED') }, result: completed('IMPLEMENTED') });
  };
  assert.deepEqual(await w.step(), { action: 'done', effort: 'alpha' });
  assert.match(w.prompt(), /\/close-out/);
  const fm = fmOnMain(b, 'alpha');
  assert.equal(fm.status, 'IMPLEMENTED');
  assert.equal(fm.claimed_by, undefined);
  assert.match(headMsg(b), /^board\(release\): alpha/);
});

test('a fatal preflight problem (unregistered worker) throws and writes nothing', async () => {
  const b = setup({ featReqs: { alpha: feat() }, workers: [] });
  const w = worker(b);
  const before = tip(b);
  await assert.rejects(w.step(), /not registered/);
  assert.equal(tip(b), before);
});
