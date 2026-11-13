import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completePath } from './complete-path.mjs';

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'cp-'));
  for (const d of ['alpha/sub', 'apple', 'beta', '.hidden']) mkdirSync(join(cwd, d), { recursive: true });
  writeFileSync(join(cwd, 'alphabet.txt'), 'x');
  return cwd;
}

test('completes a unique folder and ignores files', () => {
  const cwd = fixture();
  assert.deepEqual(completePath('be', { cwd }), [['beta/'], 'be']);
  assert.deepEqual(completePath('alphab', { cwd }), [[], 'alphab']);
  rmSync(cwd, { recursive: true });
});

test('lists every matching folder, sorted', () => {
  const cwd = fixture();
  assert.deepEqual(completePath('a', { cwd }), [['alpha/', 'apple/'], 'a']);
  rmSync(cwd, { recursive: true });
});

test('completes inside a nested path and after a trailing slash', () => {
  const cwd = fixture();
  assert.deepEqual(completePath('alpha/su', { cwd }), [['alpha/sub/'], 'alpha/su']);
  assert.deepEqual(completePath('alpha/', { cwd }), [['alpha/sub/'], 'alpha/']);
  rmSync(cwd, { recursive: true });
});

test('an empty line lists folders in cwd, hiding dot folders', () => {
  const cwd = fixture();
  assert.deepEqual(completePath('', { cwd })[0], ['alpha/', 'apple/', 'beta/']);
  assert.deepEqual(completePath('.', { cwd })[0], ['.hidden/']);
  rmSync(cwd, { recursive: true });
});

test('~ is the home directory but stays as typed', () => {
  const home = fixture();
  assert.deepEqual(completePath('~/be', { cwd: '/nowhere', home }), [['~/beta/'], '~/be']);
  rmSync(home, { recursive: true });
});

test('absolute paths work, and unreadable or missing folders give no matches', () => {
  const cwd = fixture();
  assert.deepEqual(completePath(join(cwd, 'be'), { cwd: '/nowhere' }), [[join(cwd, 'beta/')], join(cwd, 'be')]);
  assert.deepEqual(completePath('nope/x', { cwd }), [[], 'nope/x']);
  rmSync(cwd, { recursive: true });
});
