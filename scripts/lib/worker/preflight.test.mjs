import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preflight, realDeps } from './preflight.mjs';
import { workerYaml } from '../board/registry.mjs';

const ID = 'alice-abc123';
const cfg = { id: ID, agent: 'claude', model: 'opus' };

function board(over = {}, { register = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-pre-'));
  mkdirSync(join(root, 'board/workers'), { recursive: true });
  if (register) {
    writeFileSync(join(root, `board/workers/${ID}.yml`), workerYaml({
      id: ID, owner: 'alice', name: 'Alice', host: 'h', agent: 'claude', model: 'opus',
      created_at: '2026-01-01T00:00:00Z', ...over,
    }));
  }
  return root;
}
const good = { gh: { authOk: () => true }, which: () => true };
const run = (root, deps = {}, c = cfg) => preflight({ home: '/unused', cfg: c, root, ...good, ...deps });

test('ok when registered, in sync, gh logged in and CLI present', () => {
  assert.deepEqual(run(board()), { ok: true });
});

test('gh logged out is a worker problem', () => {
  assert.deepEqual(run(board(), { gh: { authOk: () => false } }), {
    ok: false, kind: 'worker', problem: 'gh is not logged in; run `gh auth login`',
  });
});

test('gh not installed is a worker problem, checked before auth', () => {
  const r = run(board(), { gh: { installed: () => false, authOk: () => false } });
  assert.deepEqual(r, { ok: false, kind: 'worker', problem: 'gh is not installed; install the GitHub CLI' });
});

test('missing agent CLI is a worker problem; agent_cmd wins over agent', () => {
  const seen = [];
  const r = run(board(), { which: (c) => { seen.push(c); return false; } }, { ...cfg, agent_cmd: 'my-claude' });
  assert.deepEqual(r, { ok: false, kind: 'worker', problem: 'agent CLI my-claude not found on PATH' });
  assert.deepEqual(seen, ['my-claude']);
});

test('unregistered is fatal', () => {
  assert.deepEqual(run(board({}, { register: false })), {
    ok: false, kind: 'fatal', problem: `worker ${ID} is not registered on the board`,
  });
});

test('retired is fatal', () => {
  assert.deepEqual(run(board({ retired_at: '2026-02-01T00:00:00Z' })), {
    ok: false, kind: 'fatal', problem: `worker ${ID} is retired`,
  });
});

test('model mismatch is fatal', () => {
  assert.deepEqual(run(board({ model: 'sonnet' })), {
    ok: false, kind: 'fatal',
    problem: 'config and registry disagree: model is opus locally but sonnet on the board',
  });
});

test('agent mismatch is fatal and beats gh/which failures', () => {
  const r = run(board({ agent: 'codex' }), { gh: { authOk: () => false }, which: () => false });
  assert.equal(r.kind, 'fatal');
  assert.match(r.problem, /agent is claude locally but codex on the board/);
});

test('realDeps exposes gh.authOk and which', () => {
  const d = realDeps();
  assert.equal(typeof d.gh.authOk, 'function');
  assert.equal(typeof d.which, 'function');
  assert.equal(typeof d.gh.installed, 'function');
  assert.equal(d.which('sh'), true);
  assert.equal(d.which('node'), true);
  assert.equal(d.which('definitely-not-a-real-cmd-xyz'), false);
});
