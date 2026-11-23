import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { makeBoard } from '../board/fixtures.mjs';
import { createWorker, newWorkerId, resolveOwner, CreateError } from './create.mjs';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-agent.mjs');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const KIT = { '.claude/skills/select-next-task/SKILL.md': '# skill\n' };
const NOW = new Date('2026-03-01T10:00:00Z');
const USER = { login: 'LidorL', name: 'Lidor L', email: 'lidor@example.com', id: 42 };

function setup({ files = KIT, board = true, script = { exitCode: 0 }, user = USER } = {}) {
  const b = makeBoard({ board, files });
  const dir = mkdtempSync(join(tmpdir(), 'create-test-'));
  const sp = join(dir, 'script.json');
  writeFileSync(sp, JSON.stringify(script));
  const agentCmd = join(dir, 'agent.sh');
  writeFileSync(agentCmd, `#!/bin/sh\nFAKE_AGENT_SCRIPT='${sp}' exec '${process.execPath}' '${FAKE}' "$@"\n`);
  chmodSync(agentCmd, 0o755);
  const env = { ...process.env, SDLC_HOME: join(dir, 'sdlc') };
  const opts = {
    metaUrl: b.remote, agent: 'claude', model: 'opus', agentCmd, gh: { api: () => user }, env, now: () => NOW, host: 'box',
  };
  const homes = () => (existsSync(join(dir, 'sdlc', 'workers')) ? readdirSync(join(dir, 'sdlc', 'workers')) : []);
  const onMain = (path) => {
    try { return git(b.remote, 'show', `main:${path}`); } catch { return null; }
  };
  return { b, opts, homes, onMain, dir };
}

test('newWorkerId and resolveOwner', () => {
  assert.match(newWorkerId('al'), /^al-[a-z0-9]{6}$/);
  assert.equal(newWorkerId('al', () => 0), 'al-000000');
  assert.deepEqual(resolveOwner({ api: () => ({ login: 'Al', name: null, email: null, id: 7 }) }),
    { login: 'al', name: 'al', email: '7+al@users.noreply.github.com' });
  assert.throws(() => resolveOwner({ api: () => ({ login: 'a_b' }) }), CreateError);
});

test('creates home, registers on main under the owner, id shape', async () => {
  const t = setup();
  const { id, home } = await createWorker(t.opts);
  assert.match(id, /^lidorl-[a-z0-9]{6}$/);
  const reg = parse(t.onMain(`board/workers/${id}.yml`));
  assert.deepEqual(reg, {
    id, owner: 'lidorl', name: id, host: 'box', agent: 'claude', model: 'opus', created_at: '2026-03-01T10:00:00Z', retired_at: null,
  });
  const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  assert.equal(cfg.id, id);
  assert.deepEqual(cfg.author, { name: 'Lidor L', email: 'lidor@example.com' });
  assert.ok(existsSync(join(home, 'agent-settings.json')));
  assert.equal(git(join(home, 'meta'), 'config', 'user.email').trim(), 'lidor@example.com');
  assert.match(readFileSync(join(home, 'meta', '.git', 'hooks', 'commit-msg'), 'utf8'), new RegExp(`Worker: ${id}`));
  assert.match(readFileSync(join(home, 'meta', '.git', 'info', 'exclude'), 'utf8'), /^\/\.sdlc-run\/$/m, 'the run dir is hidden in the clone only');
  const log = git(t.b.remote, 'log', '-1', '--format=%s%n%an <%ae>%n%(trailers:key=Worker,valueonly)', 'main');
  assert.match(log, new RegExp(`^board\\(register\\): ${id}\\nLidor L <lidor@example.com>\\n${id}`));
});

test('creates board/ and seeds config.yml when missing', async () => {
  const t = setup({ board: false });
  const { id } = await createWorker(t.opts);
  assert.ok(t.onMain(`board/workers/${id}.yml`));
  assert.equal(t.onMain('board/workers/.gitkeep'), '');
  assert.equal(t.onMain('board/requests/.gitkeep'), '');
  assert.match(t.onMain('board/config.yml'), /lease_ttl: 4h/);
});

test('id collision gives a new suffix', async () => {
  const t = setup();
  const seq = [0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
  let i = 0;
  const rand = () => seq[i++ % seq.length];
  t.b.seed('board/workers/lidorl-000000.yml', 'id: lidorl-000000\n');
  const { id } = await createWorker({ ...t.opts, rand });
  assert.equal(id, 'lidorl-iiiiii');
  assert.deepEqual(t.homes(), ['lidorl-iiiiii']);
});

test('push rejected -> retries with a fresh pull', async () => {
  const t = setup();
  const hook = join(t.b.remote, 'hooks', 'pre-receive');
  const counter = join(t.dir, 'rejects');
  writeFileSync(hook, `#!/bin/sh\nif [ ! -e '${counter}' ]; then : > '${counter}'; echo rejected >&2; exit 1; fi\n`);
  chmodSync(hook, 0o755);
  const { id } = await createWorker(t.opts);
  assert.ok(existsSync(counter));
  assert.ok(t.onMain(`board/workers/${id}.yml`));
});

test('probe failure leaves no home', async () => {
  const t = setup({ script: { exitCode: 3, stderr: 'model not found' } });
  await assert.rejects(createWorker(t.opts), /agent\/model probe failed.*model not found/s);
  assert.deepEqual(t.homes(), []);
  const ok = await createWorker({ ...t.opts, probe: false });
  assert.ok(ok.id);
});

test('wrong kit flavor names the missing path and leaves no home', async () => {
  const t = setup({ files: { '.github/skills/select-next-task/SKILL.md': '#\n' } });
  await assert.rejects(createWorker(t.opts), /\.claude\/skills\/select-next-task\/SKILL\.md/);
  assert.deepEqual(t.homes(), []);
});

test('push failure leaves no home and no registration', async () => {
  const t = setup();
  const hook = join(t.b.remote, 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\necho no >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  await assert.rejects(createWorker(t.opts), CreateError);
  assert.deepEqual(t.homes(), []);
});

test('a meta url that starts with "-" is refused before any clone, and leaves no home', async () => {
  const t = setup();
  const marker = join(t.dir, 'pwned');
  await assert.rejects(createWorker({ ...t.opts, probe: false, metaUrl: `--upload-pack=touch ${marker}` }), (e) => e instanceof CreateError && /must not start with "-"/.test(e.message));
  assert.equal(existsSync(marker), false);
  assert.deepEqual(t.homes(), []);
});

test('runs npm ci in the meta clone when there is a lockfile, npm install otherwise', async () => {
  for (const [files, want] of [[{ ...KIT, 'package.json': '{}', 'package-lock.json': '{}' }, ['ci']], [{ ...KIT, 'package.json': '{}' }, ['install']]]) {
    const t = setup({ files });
    const calls = [];
    const { home } = await createWorker({ ...t.opts, probe: false, npm: (args, cwd) => calls.push({ args, cwd }) });
    assert.deepEqual(calls, [{ args: want, cwd: join(home, 'meta') }]);
  }
});

test('a failing npm install fails create with the command and stderr, leaving no home', async () => {
  const t = setup({ files: { ...KIT, 'package.json': '{}' } });
  const npm = () => { throw Object.assign(new Error('x'), { stderr: 'ENOTFOUND registry\n' }); };
  await assert.rejects(createWorker({ ...t.opts, probe: false, npm }), (e) => e instanceof CreateError && /npm install.*ENOTFOUND/s.test(e.message));
  assert.deepEqual(t.homes(), []);
});
