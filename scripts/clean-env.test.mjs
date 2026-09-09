import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clean } from './clean-env.mjs';

const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });

// A realistic workspace checkout: cloned from a bare remote, so a "clean" one
// has nothing uncommitted and nothing unpushed.
function wsRepo(root, key, { dirty = false, unpushed = false } = {}) {
  const remote = join(root, `${key}.git`);
  mkdirSync(remote, { recursive: true });
  git(remote, 'init', '--bare', '-b', 'main');
  const seed = join(root, `seed-${key}`);
  mkdirSync(seed, { recursive: true });
  git(seed, 'init', '-b', 'main');
  git(seed, '-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', 'origin', 'main');

  const dir = join(root, 'workspace', key);
  mkdirSync(join(root, 'workspace'), { recursive: true });
  git(root, 'clone', remote, dir);
  if (unpushed) git(dir, '-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'local');
  if (dirty) writeFileSync(join(dir, 'x.txt'), 'uncommitted');
  return dir;
}

test('clean removes a clean checkout and clears the marker when empty', () => {
  const root = mkdtempSync(join(tmpdir(), 'cln-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', '.current-effort'), 'thing\n');
  wsRepo(root, 'api');
  const r = clean({ rootDir: root, keys: [], force: false });
  assert.deepEqual(r.removed, ['api']);
  assert.ok(!existsSync(join(root, 'workspace', 'api')));
  assert.ok(!existsSync(join(root, 'workspace', '.current-effort')));
  rmSync(root, { recursive: true });
});

test('clean skips a dirty checkout without --force', () => {
  const root = mkdtempSync(join(tmpdir(), 'cln-'));
  wsRepo(root, 'api', { dirty: true });
  const r = clean({ rootDir: root, keys: [], force: false });
  assert.deepEqual(r.skipped, ['api']);
  assert.ok(existsSync(join(root, 'workspace', 'api')));
  rmSync(root, { recursive: true });
});

test('clean --force removes a dirty checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'cln-'));
  wsRepo(root, 'api', { dirty: true });
  const r = clean({ rootDir: root, keys: [], force: true });
  assert.deepEqual(r.removed, ['api']);
  rmSync(root, { recursive: true });
});

test('clean skips a checkout with unpushed commits without --force', () => {
  const root = mkdtempSync(join(tmpdir(), 'cln-'));
  wsRepo(root, 'api', { unpushed: true });
  const r = clean({ rootDir: root, keys: [], force: false });
  assert.deepEqual(r.skipped, ['api']);
  rmSync(root, { recursive: true });
});

test('clean protects a non-git-looking checkout under uncertainty (git dir but no worktree state)', () => {
  const root = mkdtempSync(join(tmpdir(), 'cln-'));
  const dir = join(root, 'workspace', 'api');
  mkdirSync(dir, { recursive: true });
  // .git present but not a valid repo → git commands error → must be protected
  writeFileSync(join(dir, '.git'), 'gitdir: /nonexistent');
  const r = clean({ rootDir: root, keys: [], force: false });
  assert.deepEqual(r.skipped, ['api']);
  assert.ok(existsSync(dir));
  rmSync(root, { recursive: true });
});

test('clean removes only the named checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'cln-'));
  wsRepo(root, 'api');
  wsRepo(root, 'web');
  const r = clean({ rootDir: root, keys: ['api'], force: false });
  assert.deepEqual(r.removed, ['api']);
  assert.ok(existsSync(join(root, 'workspace', 'web')));
  rmSync(root, { recursive: true });
});
