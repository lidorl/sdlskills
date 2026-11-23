import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeBoard } from '../board/fixtures.mjs';
import { salvage } from './salvage.mjs';

const ctxFor = (b, clone, logs) => ({ clone, home: join(b.dir, 'home'), deps: { now: () => new Date('2026-06-01T10:00:00Z'), log: (m) => logs.push(m) } });

// Every entry under `dir`, recursively, with its lstat.
function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const st = lstatSync(p);
    out.push({ p, st });
    if (st.isDirectory()) walk(p, out);
  }
  return out;
}

test('P2-20g/S9: a dirty symlink is salvaged as a <name>.symlink text file holding its target, never a link or the target', () => {
  const b = makeBoard();
  const clone = b.clone('meta');
  const outside = join(b.dir, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'host secret\n');
  symlinkSync(join(outside, 'secret.txt'), join(clone, 'docs-link.md'));
  symlinkSync(join(outside, 'gone.txt'), join(clone, 'dangling.md'));
  const logs = [];
  const dir = salvage(ctxFor(b, clone, logs), { code: false, reason: 'test' });
  assert.ok(dir);
  for (const [name, target] of [['docs-link.md', join(outside, 'secret.txt')], ['dangling.md', join(outside, 'gone.txt')]]) {
    const kept = join(dir, 'meta', `${name}.symlink`);
    assert.ok(lstatSync(kept).isFile(), `${name} is kept as a regular file`);
    assert.equal(readFileSync(kept, 'utf8'), target);
    assert.equal(lstatSync(join(dir, 'meta', name), { throwIfNoEntry: false }), undefined, 'no link of that name in salvage');
    assert.equal(lstatSync(join(clone, name), { throwIfNoEntry: false }), undefined, `${name} is gone from the clone`);
  }
  assert.ok(walk(dir).every(({ st }) => !st.isSymbolicLink()), 'salvage holds no symlinks');
  assert.deepEqual(readdirSync(outside), ['secret.txt'], 'the target is untouched');
  assert.ok(logs.some((l) => /salvaged docs-link\.md -> .*docs-link\.md\.symlink \(symlink to /.test(l)), logs.join('\n'));
});

test('S9: a tracked file under a directory replaced by a symlink is skipped, never copied through either link', () => {
  const b = makeBoard({ files: { 'd/x.md': 'orig\n' } });
  const clone = b.clone('meta');
  const outside = join(b.dir, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'x.md'), 'outside x\n');
  rmSync(join(clone, 'd'), { recursive: true });
  symlinkSync(outside, join(clone, 'd')); // git status: ` D d/x.md` and `?? d`
  const logs = [];
  const dir = salvage(ctxFor(b, clone, logs), { code: false, reason: 'test' });
  assert.ok(dir);
  assert.equal(readFileSync(join(dir, 'meta', 'd.symlink'), 'utf8'), outside);
  assert.ok(walk(dir).every(({ st }) => !st.isSymbolicLink()), 'salvage holds no symlinks');
  assert.equal(lstatSync(join(dir, 'meta', 'd', 'x.md'), { throwIfNoEntry: false }), undefined, 'nothing copied through the link');
  assert.deepEqual(readdirSync(outside), ['x.md']);
  assert.equal(readFileSync(join(outside, 'x.md'), 'utf8'), 'outside x\n', 'the outside file is untouched');
  assert.ok(logs.some((l) => /skipped d\/x\.md: a parent is a symlink/.test(l)), logs.join('\n'));
  assert.ok(lstatSync(join(clone, 'd')).isDirectory(), 'the link is gone and the tracked dir is back');
  assert.equal(readFileSync(join(clone, 'd/x.md'), 'utf8'), 'orig\n');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: clone, encoding: 'utf8' }), '');
});
