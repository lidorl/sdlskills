import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { route, buildPrompt, agentCommand, runAgent, readResult, classifyFailure } from './agent.mjs';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-agent.mjs');
const tmp = () => mkdtempSync(join(tmpdir(), 'agent-test-'));

function fakeRun(dir, script, extra = {}) {
  const sp = join(dir, 'script.json');
  writeFileSync(sp, JSON.stringify(script));
  // No timeout unless a test asks for one: a slow machine must not turn into a failed run.
  return runAgent({
    cmd: process.execPath, args: [FAKE], cwd: dir, timeoutMs: 0, logPath: join(dir, 'logs', 'run.log'),
    env: { FAKE_AGENT_SCRIPT: sp, SDLC_RESULT_FILE: join(dir, 'run', 'result.json') }, ...extra,
  });
}

test('route maps each status to its skills', () => {
  assert.deepEqual(route('ACCEPTED'), { phase: 'design', skills: ['classify-change', 'write-design-doc'] });
  assert.deepEqual(route('DESIGNED'), { phase: 'plan', skills: ['write-execution-plan'] });
  assert.deepEqual(route('PLANNED'), { phase: 'develop', skills: ['executing-plans'] });
  assert.deepEqual(route('IN_PROGRESS'), { phase: 'develop', skills: ['executing-plans'], resume: true });
  assert.deepEqual(route('IN_PROGRESS', { developmentDone: true }), { phase: 'close-out', skills: ['close-out'] });
  for (const s of ['IMPLEMENTED', 'PARKED', 'REJECTED', 'NOPE']) assert.equal(route(s), null);
});

test('buildPrompt for copilot names SKILL.md paths; includes answered input', () => {
  const p = buildPrompt({ workerId: 'al-abc123', slug: 'my-feat', status: 'ACCEPTED', agent: 'copilot', agentInput: ['approve: go ahead'] });
  assert.match(p, /al-abc123/);
  assert.match(p, /my-feat/);
  assert.match(p, /\.github\/skills\/classify-change\/SKILL\.md/);
  assert.match(p, /\.github\/skills\/write-design-doc\/SKILL\.md/);
  assert.match(p, /Follow "Headless mode" in the process contract/);
  assert.match(p, /Do not commit or push in the meta repo/);
  assert.match(p, /Answered requests to apply first:[\s\S]*approve: go ahead/);

  const c = buildPrompt({ workerId: 'al-abc123', slug: 'my-feat', status: 'IN_PROGRESS', agent: 'claude' });
  assert.match(c, /superpowers:executing-plans/);
  assert.match(c, /Resume from the plan's first unchecked step\./);
  assert.doesNotMatch(c, /Answered requests/);
  const d = buildPrompt({ workerId: 'al-abc123', slug: 'my-feat', status: 'DESIGNED', agent: 'claude' });
  assert.match(d, /\/write-execution-plan/);
  const cp = buildPrompt({ workerId: 'al-abc123', slug: 'my-feat', status: 'PLANNED', agent: 'copilot' });
  assert.match(cp, /the superpowers plugin's executing-plans skill/);
});

test('agentCommand claude passes --settings and --model; env has SDLC_HEADLESS=1', () => {
  const cfg = { id: 'al-abc123', agent: 'claude', model: 'opus', cli_args: ['--x'] };
  const { cmd, args, env } = agentCommand(cfg, 'PROMPT', '/h');
  assert.equal(cmd, 'claude');
  assert.deepEqual(args, ['-p', 'PROMPT', '--model', 'opus', '--output-format', 'json', '--settings', '/h/agent-settings.json', '--x']);
  assert.equal(env.SDLC_HEADLESS, '1');
  assert.equal(env.SDLC_WORKER_ID, 'al-abc123');
  assert.equal(env.SDLC_RESULT_FILE, '/h/run/result.json');

  const cp = agentCommand({ ...cfg, agent: 'copilot', agent_cmd: '/bin/fake', cli_args: [] }, 'P', '/h');
  assert.equal(cp.cmd, '/bin/fake');
  assert.deepEqual(cp.args, ['-p', 'P', '--model', 'opus', '--allow-all-tools', '--no-color']);
});

test('runAgent with the fake agent: exit code, log written, onTick called', async () => {
  const dir = tmp();
  let ticks = 0;
  const r = await fakeRun(dir, {
    writes: { 'sub/out.txt': 'hi' }, result: { outcome: 'completed', phase: 'DESIGNED', summary: 's' },
    exitCode: 3, sleepMs: 200, stderr: 'boom',
  }, { onTick: async () => { ticks++; }, tickMs: 30 });
  assert.equal(r.exitCode, 3);
  assert.equal(r.timedOut, false);
  assert.equal(r.stderrTail, 'boom');
  assert.ok(ticks >= 2, `ticks=${ticks}`);
  assert.equal(readFileSync(join(dir, 'sub', 'out.txt'), 'utf8'), 'hi');
  assert.match(readFileSync(join(dir, 'logs', 'run.log'), 'utf8'), /boom/);
  assert.equal(readResult(join(dir, 'run', 'result.json')).ok, true);
});

test('runAgent: onTick errors are logged and do not kill the run; ticks never overlap', async () => {
  const dir = tmp();
  let active = 0; let overlap = false; let n = 0;
  const r = await fakeRun(dir, { result: null, sleepMs: 200 }, {
    tickMs: 20,
    onTick: async () => {
      active++; if (active > 1) overlap = true;
      await new Promise((res) => setTimeout(res, 50));
      active--;
      if (++n === 1) throw new Error('tick failed');
    },
  });
  assert.equal(r.exitCode, 0);
  assert.equal(overlap, false);
  assert.match(readFileSync(join(dir, 'logs', 'run.log'), 'utf8'), /onTick error: tick failed/);
});

test('runAgent kills on timeout and reports timedOut', async () => {
  const dir = tmp();
  // The child would sleep a minute and then write its result: it can only finish this early by being killed.
  const r = await fakeRun(dir, { result: { outcome: 'failed', error: { message: 'late' } }, sleepMs: 60000 }, { timeoutMs: 100 });
  assert.equal(r.timedOut, true);
  assert.ok(r.signal === 'SIGTERM' || r.exitCode !== 0);
  assert.equal(existsSync(join(dir, 'run', 'result.json')), false);
});

test('runAgent clears a stale result file before the run', async () => {
  const dir = tmp();
  const rf = join(dir, 'run', 'result.json');
  mkdirSync(dirname(rf), { recursive: true });
  writeFileSync(rf, JSON.stringify({ outcome: 'completed', phase: 'DESIGNED', summary: 'stale' }));
  assert.equal(readResult(rf).ok, true);
  await fakeRun(dir, { result: null, exitCode: 1 });
  const r = readResult(rf);
  assert.equal(r.ok, false);
  assert.match(r.problem, /missing/);
});

test('runAgent resolves spawnError on ENOENT', async () => {
  const dir = tmp();
  const r = await runAgent({ cmd: 'definitely-not-a-cli-xyz', args: [], cwd: dir, timeoutMs: 1000, logPath: join(dir, 'l.log') });
  assert.equal(r.spawnError.code, 'ENOENT');
  assert.equal(classifyFailure(r), 'worker');
});

test('readResult rejects a missing file, bad JSON and an unknown outcome', () => {
  const dir = tmp();
  const f = join(dir, 'r.json');
  assert.equal(readResult(f).ok, false);
  writeFileSync(f, '{nope');
  assert.match(readResult(f).problem, /not valid JSON/);
  writeFileSync(f, JSON.stringify({ outcome: 'weird' }));
  assert.match(readResult(f).problem, /unknown outcome/);
});

test('readResult validates each outcome', () => {
  const dir = tmp();
  const f = join(dir, 'r.json');
  const check = (o) => { writeFileSync(f, JSON.stringify(o)); return readResult(f); };
  assert.equal(check({ outcome: 'completed', phase: 'DESIGNED', summary: 'ok', extra: 1 }).ok, true);
  assert.equal(check({ outcome: 'completed', phase: 'BOGUS', summary: 'ok' }).ok, false);
  assert.equal(check({ outcome: 'completed', phase: 'DESIGNED' }).ok, false);
  const req = { kind: 'gate', blocking: true, sections: { Request: 'a', Context: 'b' } };
  assert.equal(check({ outcome: 'request', request: req }).ok, true);
  assert.equal(check({ outcome: 'request', request: { ...req, kind: 'x' } }).ok, false);
  assert.equal(check({ outcome: 'request', request: { ...req, blocking: 'yes' } }).ok, false);
  assert.equal(check({ outcome: 'request', request: { ...req, sections: { Request: 'a' } } }).ok, false);
  assert.equal(check({ outcome: 'failed', error: { message: 'm' } }).ok, true);
  assert.equal(check({ outcome: 'failed' }).ok, false);
});

test('classifyFailure: ENOENT and model errors are worker errors', () => {
  assert.equal(classifyFailure({ spawnError: Object.assign(new Error('x'), { code: 'ENOENT' }) }), 'worker');
  assert.equal(classifyFailure({ exitCode: 1, stderrTail: 'Error: model "foo" not found' }), 'worker');
  assert.equal(classifyFailure({ exitCode: 1, stderrTail: 'invalid model specified' }), 'worker');
  assert.equal(classifyFailure({ exitCode: 1, stderrTail: 'tests failed' }), 'effort');
  assert.equal(classifyFailure({ timedOut: true, stderrTail: '' }), 'effort');
});

test('runAgent abort kills the agent process group and resolves aborted', async () => {
  const dir = tmp();
  const pidFile = join(dir, 'agent.pid');
  const grandchildPidFile = join(dir, 'grandchild.pid');
  const ac = new AbortController();
  const p = fakeRun(dir, { pidFile, grandchildPidFile, sleepMs: 60000, result: { outcome: 'failed', error: { message: 'late' } } }, { signal: ac.signal });
  while (!existsSync(pidFile)) await new Promise((r) => setTimeout(r, 20));
  ac.abort();
  const r = await p;
  assert.equal(r.aborted, true);
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.equal(alive(Number(readFileSync(pidFile, 'utf8'))), false);
  for (let i = 0; i < 100 && alive(Number(readFileSync(grandchildPidFile, 'utf8'))); i++) await new Promise((res) => setTimeout(res, 20));
  assert.equal(alive(Number(readFileSync(grandchildPidFile, 'utf8'))), false);
  assert.equal(existsSync(join(dir, 'run', 'result.json')), false);
});

test('runAgent with an already-aborted signal starts nothing', async () => {
  const dir = tmp();
  const ac = new AbortController();
  ac.abort();
  const r = await fakeRun(dir, { pidFile: join(dir, 'agent.pid') }, { signal: ac.signal });
  assert.deepEqual(r, { aborted: true });
  assert.equal(existsSync(join(dir, 'agent.pid')), false);
});
