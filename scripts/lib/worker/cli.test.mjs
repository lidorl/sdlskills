import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { makeBoard } from '../board/fixtures.mjs';
import { workerYaml } from '../board/registry.mjs';
import { parseDoc } from '../board/frontmatter.mjs';
import { runAgent } from './agent.mjs';
import { workerHome, writeConfig, readConfig, readState, writePid, readPid, clearPid, isAlive } from './home.mjs';
import { runWorker } from './cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, 'fixtures', 'fake-agent.mjs');
const HARNESS = join(HERE, 'fixtures', 'worker-main.mjs');
const LOCK_RACE = join(HERE, 'fixtures', 'lock-race.mjs');
const ID = 'alice-aaaaaa';
const T0 = new Date('2026-06-01T10:00:00Z');
const OWNER = { name: 'Alice Owner', email: 'alice@users.noreply.github.com' };
const REG = { id: ID, owner: 'alice', name: ID, host: 'h', agent: 'claude', model: 'opus', created_at: '2026-01-01T00:00:00Z' };

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const onMain = (b, path) => { try { return git(b.remote, 'show', `main:${path}`); } catch { return null; } };
const fmOnMain = (b, slug) => parseDoc(onMain(b, `docs/feat-req/${slug}.md`)).data;
const tip = (b) => git(b.remote, 'rev-parse', 'main').trim();
// Sdlc-Event kinds on main since `from`, oldest first.
const eventsSince = (b, from) => git(b.remote, 'log', '--reverse', '--format=%(trailers:key=Sdlc-Event,valueonly,separator=)', `${from}..main`)
  .split('\n').map((s) => s.trim()).filter(Boolean);
const requestsOnMain = (b) => git(b.remote, 'ls-tree', '--name-only', 'main', 'board/requests/')
  .split('\n').filter((p) => p.endsWith('.md')).map((p) => parseDoc(onMain(b, p)));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const feat = (extra = {}) => ({ status: 'ACCEPTED', priority: 'high', date: '2026-05-01', ...extra });

// A board with ID registered, and ID's home (config + meta clone) under its own SDLC_HOME.
function setup({ featReqs = {}, files = {}, registry = {}, config } = {}) {
  const all = { '.gitignore': 'workspace/\n', [`board/workers/${ID}.yml`]: workerYaml({ ...REG, ...registry }), ...files };
  if (config) all['board/config.yml'] = config;
  const b = makeBoard({ featReqs, files: all });
  const env = { ...process.env, SDLC_HOME: join(b.dir, 'sdlc') };
  const home = workerHome(ID, env);
  b.clone(relative(b.dir, join(home, 'meta')));
  writeConfig(home, { id: ID, owner: 'alice', meta_url: b.remote, agent: 'claude', model: 'opus', cli_args: [], name: ID, author: OWNER });
  // cmds: pid -> command line, standing in for `ps` (a pid with no entry is some unrelated process).
  const t = { b, env, home, meta: join(home, 'meta'), seed: tip(b), logs: [], now: T0, fire: null, cmds: new Map() };
  t.asWorker = (pid) => t.cmds.set(pid, `node /x/scripts/sdlc.mjs worker start ${ID}`);
  t.loop = {
    now: () => t.now, sleep: async () => {}, gh: { installed: () => true, authOk: () => true }, which: () => true,
    log: (m) => t.logs.push(m),
    runAgent: async () => { throw new Error('no agent run expected'); },
  };
  return t;
}

// runWorker in-process. Signals are injected (t.fire(sig)); by default the first idle wait stops the worker.
async function cli(t, argv, over = {}) {
  let out = '';
  let err = '';
  const code = await runWorker(argv, {
    out: (s) => { out += s; }, err: (s) => { err += s; }, env: t.env, now: () => t.now, sleep: async () => {},
    loop: t.loop,
    procCommand: (pid) => t.cmds.get(pid) ?? null,
    onSignal: (h) => { t.fire = h; return () => { t.fire = null; }; },
    wait: async () => { t.fire?.('SIGTERM'); },
    ...over,
  });
  return { code, out, err };
}

test('start refuses when already running', async () => {
  const t = setup();
  writePid(t.home, process.pid);
  t.asWorker(process.pid);
  const r = await cli(t, ['start', ID]);
  assert.equal(r.code, 1);
  assert.match(r.err, new RegExp(`already running, pid ${process.pid}`));
  assert.equal(tip(t.b), t.seed);
  assert.equal(readPid(t.home), process.pid);
});

test('stop then start: same id and home, registry file unchanged', async () => {
  const t = setup();
  const yml = onMain(t.b, `board/workers/${ID}.yml`);
  assert.equal((await cli(t, ['start', ID])).code, 0);
  assert.equal(readPid(t.home), null);
  assert.equal(readState(t.home).clean_stop, true);
  const stop = await cli(t, ['stop', ID]);
  assert.equal(stop.code, 0);
  assert.match(stop.out, /not running/);
  assert.equal((await cli(t, ['start', ID])).code, 0);
  assert.deepEqual(eventsSince(t.b, t.seed), ['start', 'stop', 'start', 'stop']);
  assert.equal(onMain(t.b, `board/workers/${ID}.yml`), yml);
  assert.equal(readConfig(t.home).id, ID);
  const head = git(t.b.remote, 'log', '-1', '--format=%s%n%an%n%(trailers:key=Worker,valueonly,separator=)', 'main').trim().split('\n');
  assert.deepEqual(head, [`board(stop): ${ID}`, OWNER.name, ID]);

  const list = JSON.parse((await cli(t, ['list', '--json'])).out);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, ID);
  assert.equal(list[0].state, 'stopped');
  assert.equal(list[0].running, false);
  const st = await cli(t, ['status', ID]);
  assert.equal(st.code, 0);
  assert.match(st.out, new RegExp(`${ID}[\\s\\S]*stopped`));
});

test('SIGTERM mid-run: agent group killed, plan progress reported, claim released, stop event, clean_stop true', async () => {
  const t = setup({
    featReqs: { alpha: feat({ status: 'PLANNED' }) },
    files: { 'docs/plans/alpha.md': '---\nstatus: PLANNED\n---\n\n- [ ] Step 1\n- [ ] Step 2\n' },
  });
  const pidFile = join(t.b.dir, 'agent.pid');
  const grandchildPidFile = join(t.b.dir, 'grandchild.pid');
  const sp = join(t.b.dir, 'script.json');
  writeFileSync(sp, JSON.stringify({
    writes: { 'docs/plans/alpha.md': '---\nstatus: PLANNED\n---\n\n- [x] Step 1\n- [ ] Step 2\n' },
    pidFile, grandchildPidFile, sleepMs: 60000, result: { outcome: 'completed', phase: 'IMPLEMENTED', summary: 'too late' },
  }));
  t.loop.runAgent = async (opts) => {
    const p = runAgent({ ...opts, cmd: process.execPath, args: [FAKE], env: { ...opts.env, FAKE_AGENT_SCRIPT: sp } });
    while (!existsSync(pidFile)) await delay(20);
    t.fire('SIGTERM');
    return p;
  };
  const r = await cli(t, ['start', ID], { wait: async () => assert.fail('the worker must stop without idling') });
  assert.equal(r.code, 0);
  assert.equal(isAlive(Number(readFileSync(pidFile, 'utf8'))), false);
  const gc = Number(readFileSync(grandchildPidFile, 'utf8'));
  for (let i = 0; i < 100 && isAlive(gc); i++) await delay(20);
  assert.equal(isAlive(gc), false);
  assert.deepEqual(eventsSince(t.b, t.seed), ['start', 'claim', 'report', 'release', 'stop']);
  assert.match(onMain(t.b, 'docs/plans/alpha.md'), /- \[x\] Step 1/);
  const fm = fmOnMain(t.b, 'alpha');
  assert.equal(fm.status, 'PLANNED');
  assert.equal(fm.claimed_by, undefined);
  assert.equal(readState(t.home).clean_stop, true);
  assert.equal(readPid(t.home), null);
});

test('stale pid file on start → crash event + worker error request', async () => {
  const t = setup();
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  writePid(t.home, dead);
  const secret = `ghp_${'a'.repeat(36)}`;
  const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
  lines.push(`push failed with token ${secret}`);
  mkdirSync(join(t.home, 'logs'), { recursive: true });
  writeFileSync(join(t.home, 'logs', 'worker.log'), `${lines.join('\n')}\n`);
  const r = await cli(t, ['start', ID]);
  assert.equal(r.code, 0);
  assert.deepEqual(eventsSince(t.b, t.seed), ['crash', 'request', 'start', 'stop']);
  const reqs = requestsOnMain(t.b);
  assert.equal(reqs.length, 1);
  const fm = reqs[0].data;
  assert.equal(fm.kind, 'error');
  assert.equal(fm.scope, 'worker');
  assert.equal(fm.worker, ID);
  assert.equal(fm.for, 'alice');
  assert.equal(fm.blocking, true);
  const text = onMain(t.b, `board/requests/${fm.id}.md`);
  assert.match(text, new RegExp(`worker ${ID} stopped without a clean shutdown`));
  assert.match(text, /line 60\n[\s\S]*push failed with token/);
  assert.match(text, /line 12\n/);
  assert.doesNotMatch(text, /line 11\n/, 'only the last 50 lines');
  assert.doesNotMatch(text, new RegExp(secret));
  assert.ok(t.logs.some((m) => /needs attention/.test(m)), t.logs.join('\n'));
  assert.equal(readState(t.home).clean_stop, true);
});

test('start --detach returns immediately; process survives the parent; stop ends it and pushes stop', async () => {
  const t = setup({ config: 'idle_poll: 1s\n' });
  // The parent is its own process: it must exit while the worker keeps running.
  const out = execFileSync(process.execPath, [HARNESS, 'worker', 'start', ID, '--detach'], { env: t.env, encoding: 'utf8', timeout: 30000 });
  const pid = Number(/pid (\d+)/.exec(out)[1]);
  assert.equal(readPid(t.home), pid);
  try {
    for (let i = 0; i < 300 && !eventsSince(t.b, t.seed).includes('start'); i++) await delay(50);
    assert.ok(isAlive(pid));
    assert.deepEqual(eventsSince(t.b, t.seed), ['start']);
    const r = await cli(t, ['stop', ID], { wait: undefined, procCommand: undefined });
    assert.equal(r.code, 0, r.err);
    assert.equal(isAlive(pid), false);
    assert.deepEqual(eventsSince(t.b, t.seed), ['start', 'stop']);
    assert.equal(readPid(t.home), null);
    assert.equal(readState(t.home).clean_stop, true);
    assert.match(readFileSync(join(t.home, 'logs', 'worker.log'), 'utf8'), /stopped/);
  } finally {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
});

test('once with empty queue exits 0 and prints "queue empty"', async () => {
  const t = setup();
  const r = await cli(t, ['once', ID], { wait: async () => assert.fail('once never idles') });
  assert.equal(r.code, 0);
  assert.match(r.out, /queue empty/);
  assert.deepEqual(eventsSince(t.b, t.seed), ['start', 'stop']);
  assert.equal(readPid(t.home), null);
});

test('config --model updates config.json and registry; start refuses on mismatch', async () => {
  const t = setup();
  writePid(t.home, process.pid);
  t.asWorker(process.pid);
  const busy = await cli(t, ['config', ID, '--model', 'sonnet']);
  assert.equal(busy.code, 1);
  assert.match(busy.err, /running/);
  clearPid(t.home);
  assert.equal((await cli(t, ['config', ID])).code, 2);

  const r = await cli(t, ['config', ID, '--model', 'sonnet']);
  assert.equal(r.code, 0, r.err);
  assert.equal(readConfig(t.home).model, 'sonnet');
  assert.equal(parse(onMain(t.b, `board/workers/${ID}.yml`)).model, 'sonnet');
  assert.deepEqual(eventsSince(t.b, t.seed), ['config']);
  assert.match(git(t.b.remote, 'log', '-1', '--format=%s', 'main'), new RegExp(`^board\\(config\\): ${ID}`));

  t.b.seed(`board/workers/${ID}.yml`, workerYaml({ ...REG, model: 'haiku' }));
  const before = tip(t.b);
  const s = await cli(t, ['start', ID]);
  assert.equal(s.code, 1);
  assert.match(s.err, /disagree: model is sonnet locally but haiku on the board/);
  assert.equal(tip(t.b), before);
});

test('retire keeps the registry entry with retired_at, deletes home, refuses on unpushed work without --force', async () => {
  const t = setup({ featReqs: { alpha: feat({ status: 'DESIGNED', claimed_by: ID, claimed_at: '2026-06-01T09:00:00Z', renewed_at: '2026-06-01T09:00:00Z' }) } });
  const ws = join(t.meta, 'workspace', 'api');
  mkdirSync(ws, { recursive: true });
  git(ws, 'init', '-q', '-b', 'main');
  writeFileSync(join(ws, 'wip.txt'), 'unsaved\n');

  const r = await cli(t, ['retire', ID]);
  assert.equal(r.code, 1);
  assert.match(r.err, /workspace\/api/);
  assert.match(r.err, /--force/);
  assert.ok(existsSync(t.home));
  assert.equal(parse(onMain(t.b, `board/workers/${ID}.yml`)).retired_at, null);
  assert.equal(fmOnMain(t.b, 'alpha').claimed_by, undefined, 'the claim is released before the refusal');

  const f = await cli(t, ['retire', ID, '--force']);
  assert.equal(f.code, 0, f.err);
  assert.equal(existsSync(t.home), false);
  const reg = parse(onMain(t.b, `board/workers/${ID}.yml`));
  assert.deepEqual(reg, { ...REG, retired_at: '2026-06-01T10:00:00Z' });
  assert.deepEqual(eventsSince(t.b, t.seed), ['release', 'retire']);
  assert.match(git(t.b.remote, 'log', '-1', '--format=%an %(trailers:key=Worker,valueonly,separator=)', 'main').trim(), new RegExp(`^${OWNER.name} ${ID}$`));
});

test('a retired worker cannot claim or report (fatal preflight)', async () => {
  const t = setup({
    featReqs: { alpha: feat({ status: 'DESIGNED', claimed_by: ID, claimed_at: '2026-06-01T09:00:00Z', renewed_at: '2026-06-01T09:00:00Z' }), beta: feat() },
    registry: { retired_at: '2026-05-01T00:00:00Z' },
  });
  mkdirSync(join(t.meta, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(t.meta, 'docs', 'plans', 'alpha.md'), '---\nstatus: PLANNED\n---\n\n- [ ] Step 1\n');
  for (const cmd of ['once', 'start']) {
    const r = await cli(t, [cmd, ID]);
    assert.equal(r.code, 1, cmd);
    assert.match(r.err, new RegExp(`worker ${ID} is retired`));
  }
  assert.equal(tip(t.b), t.seed);
  assert.equal(fmOnMain(t.b, 'alpha').claimed_by, ID);
});

test('usage errors exit 2', async () => {
  const t = setup();
  assert.equal((await cli(t, [])).code, 2);
  assert.equal((await cli(t, ['bogus'])).code, 2);
  assert.equal((await cli(t, ['start'])).code, 2);
  assert.equal((await cli(t, ['start', 'Not An Id'])).code, 2);
  const missing = await cli(t, ['start', 'bob-zzzzzz']);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /no worker bob-zzzzzz on this machine/);
});

test('a pid file naming a live unrelated process is stale: start recovers from a crash, stop signals nothing', async () => {
  const t = setup();
  writePid(t.home, process.pid); // alive, but `ps` shows it is not this worker
  const kills = [];
  const stop = await cli(t, ['stop', ID], { kill: (pid, sig) => kills.push([pid, sig]) });
  assert.equal(stop.code, 0);
  assert.match(stop.out, /not running/);
  assert.deepEqual(kills, []);
  assert.equal((await cli(t, ['start', ID])).code, 0);
  assert.deepEqual(eventsSince(t.b, t.seed), ['crash', 'request', 'start', 'stop']);
  assert.equal(readPid(t.home), null);
});

test('two starts at once: exactly one runs, the other refuses', { timeout: 30000 }, async () => {
  const t = setup({ config: 'idle_poll: 1s\n' });
  const start = () => {
    const c = spawn(process.execPath, [HARNESS, 'worker', 'start', ID], { env: t.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    c.stderr.on('data', (x) => { err += x; });
    const exited = new Promise((r) => c.on('exit', (code) => r({ code, err })));
    return { c, exited };
  };
  const a = start();
  const b = start();
  try {
    const first = await Promise.race([a.exited.then((r) => ({ ...r, who: a })), b.exited.then((r) => ({ ...r, who: b }))]);
    assert.equal(first.code, 1);
    assert.match(first.err, /already running|being started/);
    const other = first.who === a ? b : a;
    assert.equal(readPid(t.home), other.c.pid);
    for (let i = 0; i < 300 && !eventsSince(t.b, t.seed).includes('start'); i++) await delay(50);
    const r = await cli(t, ['stop', ID], { wait: undefined, procCommand: undefined });
    assert.equal(r.code, 0, r.err);
    assert.equal((await other.exited).code, 0);
    assert.deepEqual(eventsSince(t.b, t.seed), ['start', 'stop']);
  } finally {
    for (const x of [a, b]) { try { x.c.kill('SIGKILL'); } catch { /* gone */ } }
  }
});

// A worker (pid 4242) that ignores SIGTERM, and pid 4343 named by run/agent.pid: its agent (`agentCmd`) still
// running, or some other process. Signals are recorded.
function hungWorker(t, { diesOnKill = true, agentCmd = 'node /usr/local/bin/claude -p go --model opus' } = {}) {
  writePid(t.home, 4242);
  t.asWorker(4242);
  t.cmds.set(4343, agentCmd);
  mkdirSync(join(t.home, 'run'), { recursive: true });
  writeFileSync(join(t.home, 'run', 'agent.pid'), '4343\n');
  const h = { kills: [], alive: true };
  h.deps = {
    stopTimeoutMs: 1000,
    wait: async () => {},
    isAlive: (pid) => (pid === 4242 && h.alive) || pid === 4343,
    kill: (pid, sig) => { h.kills.push([pid, sig]); if (pid === -4242 && sig === 'SIGKILL' && diesOnKill) h.alive = false; },
  };
  return h;
}

test('stop: SIGTERM ignored → SIGKILL the worker group and the agent group, then release and the stop event', async () => {
  const t = setup({ featReqs: { alpha: feat({ status: 'DESIGNED', claimed_by: ID, claimed_at: '2026-06-01T09:00:00Z', renewed_at: '2026-06-01T09:00:00Z' }) } });
  const h = hungWorker(t);
  const r = await cli(t, ['stop', ID], h.deps);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(h.kills, [[4242, 'SIGTERM'], [-4242, 'SIGKILL'], [-4343, 'SIGKILL']]);
  assert.deepEqual(eventsSince(t.b, t.seed), ['release', 'stop']);
  assert.match(git(t.b.remote, 'log', '-1', '--format=%B', 'main'), /^board\(stop\): alice-aaaaaa\n\nkilled after it did not stop in time/);
  assert.equal(fmOnMain(t.b, 'alpha').claimed_by, undefined);
  assert.equal(readState(t.home).clean_stop, true);
  assert.equal(readPid(t.home), null);
  assert.equal(existsSync(join(t.home, 'run', 'agent.pid')), false);
});

test('stop: a worker still alive after SIGKILL is an error and nothing is cleaned up', async () => {
  const t = setup({ featReqs: { alpha: feat({ status: 'DESIGNED', claimed_by: ID, claimed_at: '2026-06-01T09:00:00Z', renewed_at: '2026-06-01T09:00:00Z' }) } });
  const h = hungWorker(t, { diesOnKill: false });
  const r = await cli(t, ['stop', ID], h.deps);
  assert.equal(r.code, 1);
  assert.match(r.err, /still alive after SIGKILL/);
  assert.equal(tip(t.b), t.seed);
  assert.equal(fmOnMain(t.b, 'alpha').claimed_by, ID);
  assert.equal(readPid(t.home), 4242);
});

test('stop: when the release after a kill fails, clean_stop stays false (Ruling P2-16)', async () => {
  const t = setup({ featReqs: { alpha: feat({ status: 'DESIGNED', claimed_by: ID, claimed_at: '2026-06-01T09:00:00Z', renewed_at: '2026-06-01T09:00:00Z' }) } });
  const h = hungWorker(t);
  let pushes = 0;
  t.loop.hooks = { beforePush: () => { if (pushes++ < 3) throw new Error('network down'); } }; // the release's attempts fail
  const r = await cli(t, ['stop', ID], h.deps);
  assert.equal(r.code, 0, r.err);
  assert.equal(fmOnMain(t.b, 'alpha').claimed_by, ID);
  assert.equal(readState(t.home).clean_stop, false);
});

test('stop: an agent pid file naming some other process is never signalled (S5)', async () => {
  const t = setup();
  const h = hungWorker(t, { agentCmd: 'vim notes.txt' });
  const r = await cli(t, ['stop', ID], h.deps);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(h.kills, [[4242, 'SIGTERM'], [-4242, 'SIGKILL']]);
  assert.equal(existsSync(join(t.home, 'run', 'agent.pid')), false);
});

test('start forgets a leftover agent pid file, killing only a verified agent group', async () => {
  for (const [cmd, expected] of [['vim notes.txt', []], ['node /usr/local/bin/claude -p go', [[-4343, 'SIGKILL']]]]) {
    const t = setup();
    t.cmds.set(4343, cmd);
    mkdirSync(join(t.home, 'run'), { recursive: true });
    writeFileSync(join(t.home, 'run', 'agent.pid'), '4343\n');
    const kills = [];
    const r = await cli(t, ['start', ID], { kill: (pid, sig) => kills.push([pid, sig]), isAlive: (pid) => pid === 4343 });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(kills, expected, cmd);
    assert.equal(existsSync(join(t.home, 'run', 'agent.pid')), false);
  }
});

test('when ps cannot tell whether the pid file names this worker, start and stop refuse and touch nothing', async () => {
  const t = setup();
  writePid(t.home, process.pid);
  const kills = [];
  const over = { procCommand: () => undefined, kill: (pid, sig) => kills.push([pid, sig]) };
  for (const cmd of ['start', 'stop']) {
    const r = await cli(t, [cmd, ID], over);
    assert.equal(r.code, 1, cmd);
    assert.match(r.err, new RegExp(`cannot tell whether pid ${process.pid} is worker ${ID} \\(ps failed\\)`));
  }
  assert.deepEqual(kills, []);
  assert.equal(readPid(t.home), process.pid);
  assert.equal(tip(t.b), t.seed);
  assert.equal(JSON.parse((await cli(t, ['list', '--json'], over)).out)[0].running, 'unknown');
});

test('concurrent starts over a stale pid file: exactly one takes the lock, every round', { timeout: 60000 }, async () => {
  const t = setup();
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  for (let round = 0; round < 5; round++) {
    writePid(t.home, dead);
    const startAt = Date.now() + 500;
    const runs = Array.from({ length: 6 }, () => new Promise((res) => {
      const c = spawn(process.execPath, [LOCK_RACE, 'worker', 'start', ID, t.home, String(startAt), '700'], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      c.stdout.on('data', (x) => { out += x; });
      c.on('exit', () => res(out.trim()));
    }));
    const outs = await Promise.all(runs);
    assert.equal(outs.filter((o) => o === 'WIN').length, 1, outs.join('\n'));
    for (const o of outs.filter((x) => x !== 'WIN')) assert.match(o, /^REFUSE worker alice-aaaaaa is (already running|being started)/);
    assert.deepEqual(readdirSync(t.home).filter((n) => n.includes('.takeover-')), []);
  }
});
