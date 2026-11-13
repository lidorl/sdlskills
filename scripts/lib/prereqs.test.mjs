import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandAvailable, runCli, checkPrereqs } from './prereqs.mjs';
import { CLAUDE_LAYOUT } from '../install-sdlc.mjs';
import { COPILOT_LAYOUT } from '../install-sdlc-copilot.mjs';

const find = (list, id) => list.find((p) => p.id === id);
const all = () => true;

test('node 18 is missing and required', () => {
  const node = find(checkPrereqs({ layout: CLAUDE_LAYOUT, nodeVersion: '18.19.0', available: all }), 'node');
  assert.equal(node.ok, false);
  assert.equal(node.required, true);
  assert.match(node.fix, /nodejs\.org/);
});

test('node 20 is ok', () => {
  const node = find(checkPrereqs({ layout: CLAUDE_LAYOUT, nodeVersion: '20.0.0', available: all }), 'node');
  assert.equal(node.ok, true);
});

test('git missing is required', () => {
  const git = find(
    checkPrereqs({ layout: CLAUDE_LAYOUT, nodeVersion: '20.0.0', available: (c) => c !== 'git' }),
    'git',
  );
  assert.equal(git.ok, false);
  assert.equal(git.required, true);
});

test('claude CLI is required for the Claude layout, optional for Copilot', () => {
  for (const [layout, required] of [
    [CLAUDE_LAYOUT, true],
    [COPILOT_LAYOUT, false],
  ]) {
    const cli = find(
      checkPrereqs({ layout, nodeVersion: '20.0.0', available: (c) => c !== layout.plugin.cli }),
      'tool-cli',
    );
    assert.equal(cli.ok, false, layout.toolName);
    assert.equal(cli.required, required, layout.toolName);
    assert.ok(cli.label.includes(layout.toolName), cli.label);
    assert.ok(cli.fix.length > 0);
  }
});

test('gh is optional', () => {
  const gh = find(
    checkPrereqs({ layout: CLAUDE_LAYOUT, nodeVersion: '20.0.0', available: (c) => c !== 'gh' }),
    'gh',
  );
  assert.equal(gh.ok, false);
  assert.equal(gh.required, false);
});

test('commandAvailable uses a shell on win32 only', () => {
  const calls = [];
  const exec = (...a) => calls.push(a);
  assert.equal(commandAvailable('copilot', { exec, platform: 'win32' }), true);
  assert.equal(commandAvailable('copilot', { exec, platform: 'linux' }), true);
  assert.equal(calls[0].at(-1).shell, true);
  assert.notEqual(calls[1].at(-1).shell, true);

  const throwing = () => {
    throw new Error('ENOENT');
  };
  assert.equal(commandAvailable('copilot', { exec: throwing, platform: 'linux' }), false);
});

test('runCli passes the args through, via one command string on win32', () => {
  const calls = [];
  const exec = (...a) => calls.push(a);
  runCli('copilot', ['plugin', 'install', 'x@y'], { exec, platform: 'linux', stdio: 'inherit' });
  assert.deepEqual(calls[0][0], 'copilot');
  assert.deepEqual(calls[0][1], ['plugin', 'install', 'x@y']);

  runCli('copilot', ['plugin', 'install', 'x@y'], { exec, platform: 'win32', stdio: 'inherit' });
  assert.equal(calls[1][0], 'copilot plugin install x@y');
  assert.equal(calls[1].at(-1).shell, true);
});

test('on win32, refuses command or args that are not plain tokens', () => {
  const exec = () => assert.fail('must not run');
  assert.throws(() => runCli('copilot', ['plugin', 'install', 'x&calc'], { exec, platform: 'win32' }), /unsafe/);
  assert.throws(() => runCli('co pilot', ['x'], { exec, platform: 'win32' }), /unsafe/);
});
