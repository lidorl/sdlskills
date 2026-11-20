import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safePath, SLUG_RE, REQUEST_ID_RE, WORKER_ID_RE } from './safe-path.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'safepath-'));

test('returns the absolute path for a plain relative path', () => {
  const root = tmp();
  assert.equal(safePath(root, 'board/workers/x.yml'), join(root, 'board/workers/x.yml'));
});

test('refuses traversal and absolute escapes', () => {
  const root = tmp();
  assert.throws(() => safePath(root, '../x'), /path escapes the repository/);
  assert.throws(() => safePath(root, '/etc/passwd'), /path escapes the repository/);
  assert.throws(() => safePath(root, '.'), /path escapes the repository/);
});

test('refuses a symlinked file and a symlinked directory component', () => {
  const root = tmp();
  const outside = tmp();
  writeFileSync(join(outside, 'f'), 'x');
  mkdirSync(join(root, 'docs'));
  symlinkSync(join(outside, 'f'), join(root, 'docs/link.md'));
  symlinkSync(outside, join(root, 'board'));
  assert.throws(() => safePath(root, 'docs/link.md'), /refusing symlinked path/);
  assert.throws(() => safePath(root, 'board/workers/a.yml'), /refusing symlinked path/);
});

test('validators', () => {
  assert.ok(SLUG_RE.test('bulk-export') && !SLUG_RE.test('-x') && !SLUG_RE.test('A'));
  assert.ok(REQUEST_ID_RE.test('202611201030-abc123') && !REQUEST_ID_RE.test('2026-abc123'));
  assert.ok(WORKER_ID_RE.test('lidor-abc123') && !WORKER_ID_RE.test('Lidor-abc123') && !WORKER_ID_RE.test('../x-abc123'));
});
