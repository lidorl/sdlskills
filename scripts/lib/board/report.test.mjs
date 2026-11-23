import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeBoard } from './fixtures.mjs';
import { syncKeepingWork } from './report.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('syncKeepingWork: an untracked file identical to one main added is taken over cleanly', () => {
  const b = makeBoard();
  const c = b.clone('c');
  b.seed('docs/new.md', 'same\n');
  mkdirSync(join(c, 'docs'), { recursive: true });
  writeFileSync(join(c, 'docs/new.md'), 'same\n');
  syncKeepingWork(c, {});
  assert.equal(git(c, 'rev-parse', 'HEAD'), git(c, 'rev-parse', 'origin/main'));
  assert.equal(git(c, 'status', '--porcelain'), '');
  assert.equal(readFileSync(join(c, 'docs/new.md'), 'utf8'), 'same\n');
});
