import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { EVENT_KINDS, formatMessage, parseLog } from './events.mjs';

function git(root, ...args) {
  return execFileSync('git', ['-c', 'user.name=Tester', '-c', 'user.email=t@example.com', ...args], { cwd: root, encoding: 'utf8' });
}

test('formatMessage puts a body paragraph between the subject and the trailers', () => {
  assert.equal(
    formatMessage({ kind: 'claim', subject: 'beta', body: 'Overlap warning:\n- beta shares api with alpha\n', trailers: { worker: 'lidorl-7f3a9c', effort: 'beta' } }),
    'board(claim): beta\n\nOverlap warning:\n- beta shares api with alpha\n\nWorker: lidorl-7f3a9c\nSdlc-Event: claim\nEffort: beta\n',
  );
  assert.equal(formatMessage({ kind: 'stop', subject: 'w', body: '  ' }), 'board(stop): w\n\nSdlc-Event: stop\n');
});

test('formatMessage', () => {
  assert.equal(
    formatMessage({ kind: 'claim', subject: 'bulk-export', trailers: { worker: 'lidorl-7f3a9c', effort: 'bulk-export' } }),
    'board(claim): bulk-export\n\nWorker: lidorl-7f3a9c\nSdlc-Event: claim\nEffort: bulk-export\n');
});

test('formatMessage orders all trailers and rejects unknown kinds', () => {
  const msg = formatMessage({
    kind: 'answer', subject: 's',
    trailers: { answeredBy: 'a', replaces: 'r', phase: 'DESIGNED', request: '202601011200-abc123', effort: 'e', worker: 'w' },
  });
  assert.equal(msg, 'board(answer): s\n\nWorker: w\nSdlc-Event: answer\nEffort: e\nRequest: 202601011200-abc123\nPhase: DESIGNED\nReplaces: r\nAnswered-by: a\n');
  assert.equal(formatMessage({ kind: 'stop', subject: 'x' }), 'board(stop): x\n\nSdlc-Event: stop\n');
  assert.throws(() => formatMessage({ kind: 'bogus', subject: 'x' }), /kind/);
  assert.equal(EVENT_KINDS.length, 15);
});

test('parseLog round-trips formatMessage, skips non-board commits, honours sinceSha', () => {
  const repo = mkdtempSync(join(tmpdir(), 'board-events-'));
  try {
    git(repo, 'init', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'x');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'plain commit');
    git(repo, 'commit', '--allow-empty', '-m', formatMessage({ kind: 'claim', subject: 'bulk-export', trailers: { worker: 'lidorl-7f3a9c', effort: 'bulk-export' } }));
    git(repo, 'commit', '--allow-empty', '-m', formatMessage({ kind: 'report', subject: 'designed', trailers: { worker: 'lidorl-7f3a9c', effort: 'bulk-export', phase: 'DESIGNED' } }));
    const ev = parseLog(repo, { ref: 'HEAD' });
    assert.deepEqual(ev.map((e) => e.kind), ['report', 'claim']);
    assert.equal(ev[0].phase, 'DESIGNED');
    assert.equal(ev[0].subject, 'designed');
    assert.equal(ev[1].worker, 'lidorl-7f3a9c');
    assert.equal(ev[1].request, null);
    assert.equal(ev[1].author, 'Tester');
    assert.ok(ev[1].at instanceof Date && !Number.isNaN(ev[1].at.getTime()));
    assert.equal(parseLog(repo, { ref: 'HEAD', sinceSha: ev[1].sha }).length, 1);
    assert.equal(parseLog(repo, { ref: 'HEAD', limit: 1 }).length, 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('formatMessage refuses CR or LF in the subject or a trailer value (no forged trailers)', () => {
  assert.throws(() => formatMessage({ kind: 'claim', subject: 'x\nSdlc-Event: retire' }), /line break/);
  assert.throws(() => formatMessage({ kind: 'claim', subject: 'x\ry' }), /line break/);
  assert.throws(() => formatMessage({ kind: 'claim', subject: 'x', trailers: { effort: 'e\nReplaces: someone' } }), /line break/);
  assert.throws(() => formatMessage({ kind: 'answer', subject: 'x', trailers: { answeredBy: 'a\r\n' } }), /line break/);
});
