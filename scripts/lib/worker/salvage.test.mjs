import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeBoard } from '../board/fixtures.mjs';
import { salvage } from './salvage.mjs';

test('P2-20g: a dirty symlink is salvaged as a link, never by copying its target', () => {
  const b = makeBoard();
  const clone = b.clone('meta');
  const outside = join(b.dir, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'host secret\n');
  symlinkSync(join(outside, 'secret.txt'), join(clone, 'docs-link.md'));
  symlinkSync(join(outside, 'gone.txt'), join(clone, 'dangling.md'));
  const logs = [];
  const ctx = { clone, home: join(b.dir, 'home'), deps: { now: () => new Date('2026-06-01T10:00:00Z'), log: (m) => logs.push(m) } };
  const dir = salvage(ctx, { code: false, reason: 'test' });
  assert.ok(dir);
  for (const [name, target] of [['docs-link.md', join(outside, 'secret.txt')], ['dangling.md', join(outside, 'gone.txt')]]) {
    const kept = join(dir, 'meta', name);
    assert.ok(lstatSync(kept).isSymbolicLink(), `${name} is kept as a link`);
    assert.equal(readlinkSync(kept), target);
    assert.equal(lstatSync(join(clone, name), { throwIfNoEntry: false }), undefined, `${name} is gone from the clone`);
  }
  assert.deepEqual(readdirSync(outside), ['secret.txt'], 'the target is untouched');
  assert.ok(logs.some((l) => /salvaged docs-link\.md -> .* \(symlink\)/.test(l)), logs.join('\n'));
});
