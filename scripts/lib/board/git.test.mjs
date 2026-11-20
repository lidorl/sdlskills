import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeBoard, IDENT } from './fixtures.mjs';
import { boardWrite, assertOnMain, BoardError } from './git.mjs';

const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const revParse = (cwd, ref) => g(cwd, 'rev-parse', ref);
const noSleep = () => Promise.resolve();
const writer = (file, content) => (clone) => { writeFileSync(join(clone, file), content); return [file]; };
const base = { identity: IDENT, sleep: noSleep };

// Clone B commits + pushes `file` before A's push.
function racer(b, file, content) {
  return () => {
    writeFileSync(join(b, file), content);
    g(b, 'add', file); g(b, 'commit', '-m', 'racer'); g(b, 'push', 'origin', 'main');
  };
}

test('writes, pushes and returns the sha that is on origin/main', async () => {
  const a = makeBoard().clone('a');
  const r = await boardWrite(a, { ...base, kind: 'register', subject: 'w1', trailers: { worker: 'w1' }, onReject: 'restart', mutate: writer('board/workers/w1.md', 'hi\n') });
  assert.equal(r.ok, true);
  assert.equal(r.sha, revParse(a, 'origin/main'));
  assert.equal(g(a, 'log', '-1', '--format=%an <%ae>|%cn <%ce>'), 'Test Owner <owner@example.com>|Test Owner <owner@example.com>');
  assert.match(g(a, 'log', '-1', '--format=%B'), /Worker: w1\nSdlc-Event: register/);
});

test('restart: a rejected push resets to origin/main and returns lost-race', async () => {
  const fx = makeBoard(); const a = fx.clone('a'); const b = fx.clone('b');
  const r = await boardWrite(a, { ...base, kind: 'claim', subject: 's', onReject: 'restart', mutate: writer('x.md', 'a\n'), hooks: { beforePush: racer(b, 'y.md', 'b\n') } });
  assert.deepEqual(r, { ok: false, reason: 'lost-race' });
  assert.equal(revParse(a, 'HEAD'), revParse(a, 'origin/main'));
});

test('rebase: a rejected push on unrelated files rebases and succeeds', async () => {
  const fx = makeBoard(); const a = fx.clone('a'); const b = fx.clone('b');
  let first = true;
  const racerOnce = racer(b, 'y.md', 'b\n');
  const r = await boardWrite(a, { ...base, kind: 'claim', subject: 's', onReject: 'rebase', mutate: writer('x.md', 'a\n'), hooks: { beforePush: () => { if (first) { first = false; racerOnce(); } } } });
  assert.equal(r.ok, true);
  assert.equal(r.sha, revParse(a, 'origin/main'));
  assert.equal(readFileSync(join(a, 'y.md'), 'utf8'), 'b\n');
});

test('rebase: a conflicting change aborts, resets and returns conflict', async () => {
  const fx = makeBoard(); const a = fx.clone('a'); const b = fx.clone('b');
  const r = await boardWrite(a, { ...base, kind: 'claim', subject: 's', onReject: 'rebase', mutate: writer('README.md', 'mine\n'), hooks: { beforePush: racer(b, 'README.md', 'theirs\n') } });
  assert.deepEqual(r, { ok: false, reason: 'conflict' });
  assert.equal(revParse(a, 'HEAD'), revParse(a, 'origin/main'));
  assert.equal(readFileSync(join(a, 'README.md'), 'utf8'), 'theirs\n');
  assert.equal(g(a, 'status', '--porcelain'), '');
});

test('validate false after push returns replaced', async () => {
  const a = makeBoard().clone('a');
  const r = await boardWrite(a, { ...base, kind: 'claim', subject: 's', onReject: 'restart', mutate: writer('x.md', 'a\n'), validate: () => false });
  assert.deepEqual(r, { ok: false, reason: 'replaced' });
});

test('empty event commit for start', async () => {
  const a = makeBoard().clone('a');
  const r = await boardWrite(a, { ...base, kind: 'start', subject: 'go', trailers: { worker: 'w1' }, onReject: 'restart', mutate: () => [] });
  assert.equal(r.ok, true);
  assert.equal(g(a, 'show', '--stat', '--format=', 'HEAD'), '');
  assert.match(g(a, 'log', '-1', '--format=%B'), /Sdlc-Event: start/);
  assert.equal(r.sha, revParse(a, 'origin/main'));
});

test('empty mutate for a non-event kind is nothing-to-do and unchanged file likewise', async () => {
  const a = makeBoard().clone('a');
  const before = revParse(a, 'HEAD');
  assert.deepEqual(await boardWrite(a, { ...base, kind: 'claim', subject: 's', onReject: 'restart', mutate: () => [] }), { ok: false, reason: 'nothing-to-do' });
  assert.deepEqual(await boardWrite(a, { ...base, kind: 'claim', subject: 's', onReject: 'restart', mutate: () => ['README.md'] }), { ok: false, reason: 'nothing-to-do' });
  assert.equal(revParse(a, 'HEAD'), before);
});

test('--only leaves unrelated dirty files untouched and uncommitted', async () => {
  const fx = makeBoard(); fx.seed('notes.md', 'one\n'); const a = fx.clone('a');
  writeFileSync(join(a, 'notes.md'), 'dirty\n');
  const r = await boardWrite(a, { ...base, kind: 'claim', subject: 's', onReject: 'restart', mutate: writer('x.md', 'a\n') });
  assert.equal(r.ok, true);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: a, encoding: 'utf8' }), ' M notes.md\n');
  assert.equal(g(a, 'show', 'HEAD:notes.md'), 'one');
  assert.deepEqual(g(a, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['x.md']);
});

test('dirty unrelated file survives a lost race with restart', async () => {
  const fx = makeBoard(); fx.seed('notes.md', 'one\n'); const a = fx.clone('a'); const b = fx.clone('b');
  writeFileSync(join(a, 'notes.md'), 'dirty\n');
  const r = await boardWrite(a, { ...base, kind: 'claim', subject: 's', onReject: 'restart', mutate: writer('x.md', 'a\n'), hooks: { beforePush: racer(b, 'y.md', 'b\n') } });
  assert.equal(r.reason, 'lost-race');
  assert.equal(readFileSync(join(a, 'notes.md'), 'utf8'), 'dirty\n');
});

test('sync throws when local commits diverged', async () => {
  const fx = makeBoard(); const a = fx.clone('a'); const b = fx.clone('b');
  writeFileSync(join(a, 'l.md'), 'x\n'); g(a, 'add', 'l.md'); g(a, 'commit', '-m', 'local');
  racer(b, 'y.md', 'b\n')();
  await assert.rejects(boardWrite(a, { ...base, kind: 'claim', subject: 's', onReject: 'restart', mutate: writer('x.md', 'a\n') }), (e) => e instanceof BoardError && /fast-forward/.test(e.message));
});

test('assertOnMain throws off main', () => {
  const a = makeBoard().clone('a');
  assertOnMain(a);
  g(a, 'checkout', '-b', 'topic');
  assert.throws(() => assertOnMain(a), (e) => e instanceof BoardError && e.message === 'not on main');
});

const once = (fn) => { let done = false; return () => { if (!done) { done = true; fn(); } }; };
const originHas = (a, sha) => { try { g(a, 'merge-base', '--is-ancestor', sha, 'origin/main'); return true; } catch { return false; } };

test('C1: local unpushed commits make boardWrite throw before publishing them', async () => {
  const a = makeBoard().clone('a');
  writeFileSync(join(a, 'mine.md'), 'x\n'); g(a, 'add', 'mine.md'); g(a, 'commit', '-m', 'person work');
  const mine = revParse(a, 'HEAD');
  await assert.rejects(boardWrite(a, { ...base, kind: 'claim', subject: 's', onReject: 'restart', mutate: writer('x.md', 'a\n') }),
    (e) => e instanceof BoardError && /local commits ahead/.test(e.message));
  g(a, 'fetch', 'origin', 'main');
  assert.equal(originHas(a, mine), false);
});

test('C1: local unpushed commits survive (not dropped) when the write would have lost the race', async () => {
  const fx = makeBoard(); const a = fx.clone('a'); const b = fx.clone('b');
  writeFileSync(join(a, 'mine.md'), 'x\n'); g(a, 'add', 'mine.md'); g(a, 'commit', '-m', 'person work');
  const mine = revParse(a, 'HEAD');
  await assert.rejects(boardWrite(a, { ...base, kind: 'claim', subject: 's', onReject: 'restart', mutate: writer('x.md', 'a\n'), hooks: { beforePush: racer(b, 'y.md', 'b\n') } }), BoardError);
  assert.equal(revParse(a, 'HEAD'), mine);
});

test('I1: a dirty file that --keep cannot preserve ends clean at origin/main, work kept in stash', async () => {
  const fx = makeBoard(); fx.seed('notes.md', 'one\n'); const a = fx.clone('a'); const b = fx.clone('b');
  writeFileSync(join(a, 'notes.md'), 'dirty\n');
  await assert.rejects(boardWrite(a, { ...base, kind: 'claim', subject: 's', onReject: 'restart', mutate: writer('x.md', 'a\n'), hooks: { beforePush: racer(b, 'notes.md', 'theirs\n') } }),
    (e) => e instanceof BoardError);
  assert.equal(revParse(a, 'HEAD'), revParse(a, 'origin/main'));
  assert.equal(g(a, 'status', '--porcelain'), '');
  assert.match(g(a, 'stash', 'show', '-p'), /dirty/);
  // clone is usable afterwards
  g(a, 'stash', 'drop');
  assert.equal((await boardWrite(a, { ...base, kind: 'claim', subject: 's', onReject: 'restart', mutate: writer('z.md', 'z\n') })).ok, true);
});

test('I2: rebase whose autostash pop conflicts never pushes and leaves the clone clean at origin/main', async () => {
  const fx = makeBoard(); fx.seed('notes.md', 'one\n'); const a = fx.clone('a'); const b = fx.clone('b');
  writeFileSync(join(a, 'notes.md'), 'dirty\n');
  await assert.rejects(boardWrite(a, { ...base, kind: 'claim', subject: 's', onReject: 'rebase', mutate: writer('x.md', 'a\n'), hooks: { beforePush: once(racer(b, 'notes.md', 'theirs\n')) } }),
    (e) => e instanceof BoardError);
  assert.equal(revParse(a, 'HEAD'), revParse(a, 'origin/main'));
  assert.equal(g(a, 'status', '--porcelain'), '');
  assert.equal(g(a, 'diff', '--name-only', '--diff-filter=U'), '');
});

test('I3: rebase commits use the supplied identity, not the clone config', async () => {
  const fx = makeBoard(); const a = fx.clone('a', { name: 'Someone Else', email: 'else@example.com' }); const b = fx.clone('b');
  const r = await boardWrite(a, { ...base, kind: 'claim', subject: 's', onReject: 'rebase', mutate: writer('x.md', 'a\n'), hooks: { beforePush: once(racer(b, 'y.md', 'b\n')) } });
  assert.equal(r.ok, true);
  assert.equal(g(a, 'log', '-1', '--format=%an <%ae>|%cn <%ce>'), 'Test Owner <owner@example.com>|Test Owner <owner@example.com>');
});

test('I4: event kind whose rebased commit becomes a no-op is kept, sha is ours', async () => {
  const fx = makeBoard(); const a = fx.clone('a'); const b = fx.clone('b');
  const r = await boardWrite(a, { ...base, kind: 'renew', subject: 's', onReject: 'rebase', mutate: writer('x.md', 'same\n'), hooks: { beforePush: once(racer(b, 'x.md', 'same\n')) } });
  assert.equal(r.ok, true);
  assert.equal(r.sha, revParse(a, 'origin/main'));
  assert.match(g(a, 'log', '-1', '--format=%B', r.sha), /Sdlc-Event: renew/);
});

test('I4: non-event kind whose rebased commit becomes a no-op returns nothing-to-do', async () => {
  const fx = makeBoard(); const a = fx.clone('a'); const b = fx.clone('b');
  const r = await boardWrite(a, { ...base, kind: 'claim', subject: 's', onReject: 'rebase', mutate: writer('x.md', 'same\n'), hooks: { beforePush: once(racer(b, 'x.md', 'same\n')) } });
  assert.deepEqual(r, { ok: false, reason: 'nothing-to-do' });
  assert.equal(revParse(a, 'HEAD'), revParse(a, 'origin/main'));
});

test('R2: an empty start event does not sweep a staged new file', async () => {
  const a = makeBoard().clone('a');
  writeFileSync(join(a, 'secret.md'), 's\n'); g(a, 'add', 'secret.md');
  const r = await boardWrite(a, { ...base, kind: 'start', subject: 'go', onReject: 'restart', mutate: () => [] });
  assert.equal(r.ok, true);
  assert.equal(g(a, 'show', '--name-only', '--format=', 'HEAD'), '');
  assert.equal(g(a, 'diff', '--cached', '--name-only'), 'secret.md');
});

test('R2: a renew emptied by rebase does not sweep a staged new file', async () => {
  const fx = makeBoard(); const a = fx.clone('a'); const b = fx.clone('b');
  writeFileSync(join(a, 'secret.md'), 's\n'); g(a, 'add', 'secret.md');
  const r = await boardWrite(a, { ...base, kind: 'renew', subject: 's', onReject: 'rebase', mutate: writer('x.md', 'same\n'), hooks: { beforePush: once(racer(b, 'x.md', 'same\n')) } });
  assert.equal(r.ok, true);
  assert.equal(g(a, 'show', '--name-only', '--format=', 'HEAD'), '');
  assert.equal(g(a, 'diff', '--cached', '--name-only'), 'secret.md');
});
