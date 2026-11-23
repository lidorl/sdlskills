import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, statSync, appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { makeBoard, IDENT } from './fixtures.mjs';
import { boardWrite, assertOnMain, BoardError, sync, identityEnv } from './git.mjs';
import { renew } from './claims.mjs';

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

test('keep-work: a lost race restores only our own files; upstream changes stay, overlaps become .ours-<sha7>', async () => {
  const fx = makeBoard(); fx.seed('shared.md', 'base\n'); fx.seed('unrelated.md', 'u\n');
  const a = fx.clone('a'); const b = fx.clone('b');
  const mutate = (clone) => {
    writeFileSync(join(clone, 'new.md'), 'mine\n');
    writeFileSync(join(clone, 'shared.md'), 'ours\n');
    return ['new.md', 'shared.md'];
  };
  const race = () => {
    writeFileSync(join(b, 'shared.md'), 'theirs\n');
    writeFileSync(join(b, 'unrelated.md'), 'changed upstream\n');
    g(b, 'add', '-A'); g(b, 'commit', '-m', 'racer'); g(b, 'push', 'origin', 'main');
  };
  const ourSha = () => g(a, 'rev-parse', 'HEAD').slice(0, 7);
  let sha7;
  const r = await boardWrite(a, { ...base, kind: 'report', subject: 's', onReject: 'restart', onFailure: 'keep-work', mutate, hooks: { beforePush: () => { sha7 = ourSha(); race(); } } });
  assert.equal(r.reason, 'lost-race');
  assert.deepEqual(r.kept, ['new.md']);
  assert.deepEqual(r.conflicted, ['shared.md']);
  assert.equal(revParse(a, 'HEAD'), revParse(a, 'origin/main'));
  assert.equal(readFileSync(join(a, 'new.md'), 'utf8'), 'mine\n');
  assert.equal(readFileSync(join(a, 'shared.md'), 'utf8'), 'theirs\n');
  assert.equal(readFileSync(join(a, `shared.md.ours-${sha7}`), 'utf8'), 'ours\n');
  assert.equal(readFileSync(join(a, 'unrelated.md'), 'utf8'), 'changed upstream\n');
  assert.equal(g(a, 'status', '--porcelain').split('\n').sort().join('|'), `?? new.md|?? shared.md.ours-${sha7}`);
});

test('default discard: a lost race removes the file our commit added', async () => {
  const fx = makeBoard(); const a = fx.clone('a'); const b = fx.clone('b');
  await boardWrite(a, { ...base, kind: 'claim', subject: 's', onReject: 'restart', mutate: writer('new.md', 'mine\n'), hooks: { beforePush: racer(b, 'y.md', 'b\n') } });
  assert.throws(() => readFileSync(join(a, 'new.md')));
});

test('keep-work gives back binary files byte for byte and keeps the exec bit', async () => {
  const fx = makeBoard(); const a = fx.clone('a'); const b = fx.clone('b');
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x0d, 0x0a, 0x80, 0xc3, 0x28]);
  const mutate = (clone) => {
    writeFileSync(join(clone, 'logo.png'), bytes);
    writeFileSync(join(clone, 'run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 });
    return ['logo.png', 'run.sh'];
  };
  const r = await boardWrite(a, { ...base, kind: 'report', subject: 's', onReject: 'restart', onFailure: 'keep-work', mutate, hooks: { beforePush: once(racer(b, 'y.md', 'b\n')) } });
  assert.equal(r.reason, 'lost-race');
  assert.deepEqual(r.kept.sort(), ['logo.png', 'run.sh']);
  assert.deepEqual(readFileSync(join(a, 'logo.png')), bytes);
  assert.equal(statSync(join(a, 'run.sh')).mode & 0o111, 0o111);
});

test('commitFromHead: an edit the person has not committed is never part of the commit', async () => {
  const fx = makeBoard({ featReqs: { s: { status: 'ACCEPTED' } } }); const a = fx.clone('a');
  const f = join(a, 'docs/feat-req/s.md');
  writeFileSync(f, readFileSync(f, 'utf8').replace('# s', '# s\n\nprivate draft'));
  const draft = readFileSync(f, 'utf8');
  const mutate = (tree) => tree.write('docs/feat-req/s.md', tree.read('docs/feat-req/s.md').replace('ACCEPTED', 'DESIGNED'));
  const r = await boardWrite(a, { ...base, kind: 'apply', subject: 's', onReject: 'restart', commitFromHead: true, mutate });
  assert.equal(r.ok, true);
  const committed = g(a, 'show', `${r.sha}:docs/feat-req/s.md`);
  assert.match(committed, /DESIGNED/);
  assert.doesNotMatch(committed, /private draft/);
  assert.equal(readFileSync(f, 'utf8'), draft); // the person's copy is theirs: left exactly as it was
});

// Protocol writes (commitFromHead) build their commit in a temporary index and never touch the working tree.
const LEASE = { status: 'IN_PROGRESS', claimed_by: 'a-w', claimed_at: '2026-11-20T11:00:00Z', renewed_at: '2026-11-20T11:00:00Z' };
const PLAN = '# plan\n\n- [ ] one\n';
const held = () => makeBoard({ featReqs: { s: LEASE }, files: { 'docs/plans/s.md': PLAN } });
const FEAT = 'docs/feat-req/s.md';
const RENEW_AT = new Date('2026-11-20T12:00:00.000Z');

test('process killed mid-push loses no uncommitted docs edit', () => {
  const a = held().clone('a');
  const feat = join(a, FEAT);
  const draft = `${readFileSync(feat, 'utf8')}\ndraft line\n`;
  writeFileSync(feat, draft);
  mkdirSync(join(a, 'docs/design'), { recursive: true });
  writeFileSync(join(a, 'docs/design/s.md'), 'design draft\n');
  const child = join(mkdtempSync(join(tmpdir(), 'board-kill-')), 'kill.mjs');
  writeFileSync(child, [
    `import { renew } from ${JSON.stringify(new URL('./claims.mjs', import.meta.url).href)};`,
    `await renew(process.argv[2], 's', { claimant: 'a-w', identity: ${JSON.stringify(IDENT)}, now: new Date('${RENEW_AT.toISOString()}'),`,
    '  hooks: { beforePush: () => process.exit(7) } });',
  ].join('\n'));
  const r = spawnSync(process.execPath, [child, a], { encoding: 'utf8' });
  rmSync(dirname(child), { recursive: true, force: true });
  assert.equal(r.status, 7, r.stderr);
  assert.equal(readFileSync(feat, 'utf8'), draft);
  assert.equal(readFileSync(join(a, 'docs/design/s.md'), 'utf8'), 'design draft\n');
});

test('a file written during the push survives', async () => {
  const a = held().clone('a');
  const feat = join(a, FEAT); const plan = join(a, 'docs/plans/s.md');
  writeFileSync(feat, `${readFileSync(feat, 'utf8')}\ndraft line\n`);
  writeFileSync(plan, `${PLAN}- [ ] two\n`);
  const hooks = { beforePush: () => { appendFileSync(plan, 'written during push\n'); appendFileSync(feat, 'also during push\n'); } };
  const r = await renew(a, 's', { claimant: 'a-w', identity: IDENT, now: RENEW_AT, hooks });
  assert.equal(r.ok, true);
  assert.equal(readFileSync(plan, 'utf8'), `${PLAN}- [ ] two\nwritten during push\n`);
  assert.match(readFileSync(feat, 'utf8'), /draft line\nalso during push\n$/);
});

test('protocol commit contains only the patched frontmatter, never working-tree edits', async () => {
  const fx = held(); const a = fx.clone('a');
  const feat = join(a, FEAT);
  writeFileSync(feat, `${readFileSync(feat, 'utf8')}\ndraft line\n`);
  writeFileSync(join(a, 'README.md'), 'staged edit\n'); g(a, 'add', 'README.md');
  mkdirSync(join(a, 'docs/design'), { recursive: true });
  writeFileSync(join(a, 'docs/design/s.md'), 'design draft\n');
  const r = await renew(a, 's', { claimant: 'a-w', identity: IDENT, now: RENEW_AT });
  assert.equal(r.ok, true);
  assert.equal(g(fx.remote, 'show', '--name-only', '--format=', 'main'), FEAT);
  const diff = g(fx.remote, 'diff', '-U0', 'main~1', 'main').split('\n').filter((l) => /^[-+][^-+]/.test(l));
  assert.deepEqual(diff, ['-renewed_at: 2026-11-20T11:00:00Z', '+renewed_at: 2026-11-20T12:00:00Z']);
  assert.equal(g(a, 'diff', '--cached', '--name-only'), 'README.md');
});

const patchAll = (tree) => {
  tree.write(FEAT, tree.read(FEAT).replace('IN_PROGRESS', 'PARKED'));
  tree.write('docs/plans/s.md', tree.read('docs/plans/s.md').replace('one', 'one (patched)'));
  tree.write('board/requests/202611201200-aaaaaa.md', 'new\n');
};
const applyWrite = (a, extra = {}) => boardWrite(a, { ...base, kind: 'apply', subject: 's', onReject: 'restart', commitFromHead: true, mutate: patchAll, ...extra });
const status = (a) => execFileSync('git', ['status', '--porcelain'], { cwd: a, encoding: 'utf8' });

test('clean working files are fast-forwarded to the new HEAD and local main follows', async () => {
  const a = held().clone('a');
  const r = await applyWrite(a);
  assert.equal(r.ok, true);
  assert.equal(revParse(a, 'HEAD'), r.sha);
  assert.equal(readFileSync(join(a, 'docs/plans/s.md'), 'utf8'), PLAN.replace('one', 'one (patched)'));
  assert.equal(readFileSync(join(a, 'board/requests/202611201200-aaaaaa.md'), 'utf8'), 'new\n');
  assert.match(readFileSync(join(a, FEAT), 'utf8'), /PARKED/);
  assert.equal(status(a), '');
});

test('a dirty touched path: local main is not advanced, nothing is touched, a later sync merges the change in', async () => {
  const fx = held(); const a = fx.clone('a');
  const before = revParse(a, 'HEAD');
  const feat = join(a, FEAT);
  const mine = `${readFileSync(feat, 'utf8')}\ndraft line\n`;
  writeFileSync(feat, mine);
  const r = await applyWrite(a);
  assert.equal(r.ok, true);
  assert.equal(revParse(a, 'HEAD'), before);
  assert.equal(readFileSync(feat, 'utf8'), mine);
  assert.equal(readFileSync(join(a, 'docs/plans/s.md'), 'utf8'), PLAN); // clean, but main did not move: untouched
  assert.equal(status(a), ` M ${FEAT}\n`);
  assert.equal(g(a, 'diff', '--cached'), '');
  sync(a, identityEnv(IDENT)); // what `sdlc report` does first
  assert.equal(revParse(a, 'HEAD'), r.sha);
  const merged = readFileSync(feat, 'utf8');
  assert.match(merged, /status: PARKED[\s\S]*draft line/);
  assert.equal(g(a, 'stash', 'list'), '');
});

test('a staged edit to a touched path stays staged as the person left it; main is not advanced', async () => {
  const a = held().clone('a');
  const before = revParse(a, 'HEAD');
  const plan = join(a, 'docs/plans/s.md');
  writeFileSync(plan, `${PLAN}- [ ] staged step\n`); g(a, 'add', 'docs/plans/s.md');
  const cached = g(a, 'diff', '--cached');
  const r = await applyWrite(a);
  assert.equal(r.ok, true);
  assert.equal(revParse(a, 'HEAD'), before);
  assert.equal(g(a, 'diff', '--cached'), cached);
  assert.equal(readFileSync(plan, 'utf8'), `${PLAN}- [ ] staged step\n`);
});

test('index.lock held when the write lands: no staged revert and local main is not moved', async () => {
  const a = held().clone('a');
  const before = revParse(a, 'HEAD');
  const lock = join(a, '.git/index.lock');
  const r = await renew(a, 's', { claimant: 'a-w', identity: IDENT, now: RENEW_AT, hooks: { beforePush: () => writeFileSync(lock, '') } });
  rmSync(lock);
  assert.equal(r.ok, true);
  assert.equal(revParse(a, 'HEAD'), before);
  assert.equal(g(a, 'diff', '--cached'), '');
  assert.equal(status(a), '');
});

test('origin/main moved under a dirty edit to the same lines: renew still lands, nothing is stashed or reset', async () => {
  const fx = held(); const a = fx.clone('a');
  const before = revParse(a, 'HEAD');
  const plan = join(a, 'docs/plans/s.md');
  writeFileSync(plan, '# plan\n\n- [ ] AGENT\n');
  fx.seed('docs/plans/s.md', '# plan\n\n- [ ] PERSON\n');
  const r = await renew(a, 's', { claimant: 'a-w', identity: IDENT, now: RENEW_AT });
  assert.equal(r.ok, true);
  assert.equal(readFileSync(plan, 'utf8'), '# plan\n\n- [ ] AGENT\n');
  assert.equal(g(a, 'stash', 'list'), '');
  assert.equal(revParse(a, 'HEAD'), before); // behind origin/main, never ahead
  assert.match(g(fx.remote, 'show', `main:${FEAT}`), /renewed_at: 2026-11-20T12:00:00Z/);
});

test('P2-20a: a commitFromHead renew lands while a local commit sits ahead in meta; the commit stays local and unpublished', async () => {
  const fm = '---\nclaimed_by: a-w\nclaimed_at: 2026-11-20T11:00:00Z\nrenewed_at: 2026-11-20T11:00:00Z\nstatus: DESIGNED\n---\n\n# s\n';
  const fx = makeBoard({ files: { 'docs/feat-req/s.md': fm } });
  const a = fx.clone('a');
  writeFileSync(join(a, 'docs/agent.md'), 'agent\n'); g(a, 'add', 'docs/agent.md'); g(a, 'commit', '-m', 'agent commit');
  const mine = revParse(a, 'HEAD');
  const r = await renew(a, 's', { claimant: 'a-w', identity: IDENT, now: new Date('2026-11-20T12:00:00Z'), sleep: noSleep });
  assert.equal(r.ok, true);
  assert.match(g(fx.remote, 'show', 'main:docs/feat-req/s.md'), /renewed_at: 2026-11-20T12:00:00Z/);
  assert.equal(originHas(a, mine), false, 'the local commit is never pushed');
  assert.equal(revParse(a, 'HEAD'), mine, 'local main is left where it was');
});

test('P2-20a: a working-tree write still refuses while a local commit sits ahead', async () => {
  const a = makeBoard().clone('a');
  writeFileSync(join(a, 'mine.md'), 'x\n'); g(a, 'add', 'mine.md'); g(a, 'commit', '-m', 'person work');
  await assert.rejects(boardWrite(a, { ...base, kind: 'report', subject: 's', onReject: 'rebase', sync: () => {}, mutate: writer('x.md', 'a\n') }),
    (e) => e instanceof BoardError && /local commits ahead/.test(e.message));
});
