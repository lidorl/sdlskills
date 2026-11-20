import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  sdlcHome, workerHome, readConfig, writeConfig, readState, writeState,
  writePid, readPid, clearPid, isAlive, agentSettings, installTrailerHook,
} from './home.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'sdlc-home-'));
const ID = 'alice-abc123';

test('SDLC_HOME overrides ~/.sdlc', () => {
  assert.equal(sdlcHome({ SDLC_HOME: '/x/y' }), '/x/y');
  assert.match(sdlcHome({ HOME: '/h' }), /\.sdlc$/);
  assert.equal(workerHome(ID, { SDLC_HOME: '/x/y' }), join('/x/y', 'workers', ID));
  assert.throws(() => workerHome('../evil', { SDLC_HOME: '/x' }));
  assert.throws(() => workerHome('Alice-abc123', { SDLC_HOME: '/x' }));
});

test('config and state round-trip; state has defaults', () => {
  const home = tmp();
  const cfg = {
    id: ID, owner: 'alice', meta_url: 'git@x:y.git', agent: 'claude', model: 'm', cli_args: ['--a'],
    name: 'Alice', author: { name: 'Alice', email: 'a@users.noreply.github.com' },
  };
  writeConfig(home, cfg);
  assert.deepEqual(readConfig(home), cfg);
  assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), JSON.stringify(cfg, null, 2) + '\n');
  assert.ok(!existsSync(join(home, 'config.json.tmp')));
  assert.deepEqual(readState(home), { clean_stop: true, failures: 0, backoff_until: null });
  writeState(home, { failures: 2 });
  writeState(home, { clean_stop: false });
  assert.deepEqual(readState(home), { clean_stop: false, failures: 2, backoff_until: null });
  writePid(home, 4242);
  assert.equal(readPid(home), 4242);
  clearPid(home);
  assert.equal(readPid(home), null);
  clearPid(home);
});

test('isAlive true for process.pid, false for a reaped child pid', () => {
  assert.equal(isAlive(process.pid), true);
  const r = spawnSync(process.execPath, ['-e', '']);
  assert.equal(isAlive(r.pid), false);
  assert.equal(isAlive(0), false);
  assert.equal(isAlive(-1), false);
  assert.equal(isAlive(1.5), false);
});

function repo() {
  const dir = tmp();
  const g = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.name', 't'); g('config', 'user.email', 't@t');
  return { dir, g };
}
const body = (g) => g('log', '-1', '--format=%B').stdout;
const count = (s) => s.split('\n').filter((l) => l.startsWith('Worker:')).length;

test('commit-msg hook adds Worker trailer once, even if commit already has one', () => {
  const { dir, g } = repo();
  installTrailerHook(dir, ID);
  const hook = join(dir, '.git/hooks/commit-msg');
  assert.equal(statSync(hook).mode & 0o777, 0o755);
  g('commit', '--allow-empty', '-q', '-m', 'one');
  assert.equal(count(body(g)), 1);
  assert.match(body(g), /Worker: alice-abc123/);
  g('commit', '--allow-empty', '-q', '-m', `two\n\nWorker: ${ID}`);
  assert.equal(count(body(g)), 1);
  assert.throws(() => installTrailerHook(dir, '../x'));
});

test('installTrailerHook chains an existing hook, idempotently, and leaves pre-commit', () => {
  const { dir, g } = repo();
  const hooks = join(dir, '.git/hooks');
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, 'commit-msg'), '#!/bin/sh\necho old >> "$(dirname "$0")/ran"\n', { mode: 0o755 });
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o555 });
  installTrailerHook(dir, ID);
  installTrailerHook(dir, ID);
  g('commit', '--allow-empty', '-q', '-m', 'x');
  assert.equal(readFileSync(join(hooks, 'ran'), 'utf8'), 'old\n');
  assert.equal(count(body(g)), 1);
  assert.equal(readFileSync(join(hooks, 'pre-commit'), 'utf8'), '#!/bin/sh\nexit 0\n');
  assert.equal(statSync(join(hooks, 'pre-commit')).mode & 0o777, 0o555);
});

test('agentSettings enables the sandbox', () => {
  assert.deepEqual(agentSettings(), {
    sandbox: { enabled: true, autoAllowBashIfSandboxed: true },
    permissions: { defaultMode: 'acceptEdits' },
  });
});
