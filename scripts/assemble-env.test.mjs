import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRepoKeys, assemble } from './assemble-env.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });

function bareRemote(dir, name, { effortBranch } = {}) {
  const remote = join(dir, `${name}.git`);
  mkdirSync(remote);
  git(remote, 'init', '--bare', '-b', 'main');
  const work = join(dir, `seed-${name}`);
  mkdirSync(work);
  git(work, 'init', '-b', 'main');
  git(work, '-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init');
  git(work, 'remote', 'add', 'origin', remote);
  git(work, 'push', 'origin', 'main');
  if (effortBranch) {
    git(work, 'checkout', '-b', effortBranch);
    git(work, '-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'work from a prior session');
    git(work, 'push', 'origin', effortBranch);
  }
  return remote;
}

const log = (dir) => execFileSync('git', ['log', '--oneline'], { cwd: dir }).toString();

// Local filesystem paths stand in for git remotes in these tests. The catalog
// validator (catalog.mjs) rejects non-https/ssh urls, so tests pass an explicit
// in-memory `catalog` to assemble() rather than going through loadCatalog().
function entry(url, extra = {}) {
  return { url, default_branch: 'main', domain: 'x', summary: 's', responsibilities: ['x'], depends_on: [], keywords: [], notes: false, readonly: false, ...extra };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'asm-'));
  const apiRemote = bareRemote(dir, 'api');
  const webRemote = bareRemote(dir, 'web');
  const root = join(dir, 'root');
  mkdirSync(join(root, 'docs', 'design'), { recursive: true });
  writeFileSync(join(root, 'docs', 'design', 'thing.md'),
    `---\nfeat_req: docs/feat-req/thing.md\nrepos: [api]\nstatus: APPROVED\n---\n# Thing\n`);
  const catalog = { repos: { api: entry(apiRemote), web: entry(webRemote) } };
  return { dir, root, catalog };
}

test('resolveRepoKeys reads the design doc repos list plus extras', () => {
  const { dir, root } = setup();
  assert.deepEqual(resolveRepoKeys(root, 'thing', ['web']).sort(), ['api', 'web']);
  rmSync(dir, { recursive: true });
});

test('assemble clones missing repos on the effort branch and writes the marker', () => {
  const { dir, root, catalog } = setup();
  const r = assemble({ rootDir: root, slug: 'thing', keys: ['api'], catalog });
  assert.deepEqual(r.cloned, ['api']);
  assert.equal(r.branch, 'feat/thing');
  assert.ok(existsSync(join(root, 'workspace', 'api', '.git')));
  assert.equal(
    execFileSync('git', ['branch', '--show-current'], { cwd: join(root, 'workspace', 'api') }).toString().trim(),
    'feat/thing'
  );
  assert.equal(readFileSync(join(root, 'workspace', '.current-effort'), 'utf8').trim(), 'thing');
  rmSync(dir, { recursive: true });
});

test('assemble is idempotent — second run fetches, does not re-clone', () => {
  const { dir, root, catalog } = setup();
  assemble({ rootDir: root, slug: 'thing', keys: ['api'], catalog });
  const r2 = assemble({ rootDir: root, slug: 'thing', keys: ['api'], catalog });
  assert.deepEqual(r2.cloned, []);
  assert.deepEqual(r2.fetched, ['api']);
  rmSync(dir, { recursive: true });
});

test('assemble warns and reassembles when .current-effort names another effort', () => {
  const { dir, root, catalog } = setup();
  assemble({ rootDir: root, slug: 'thing', keys: ['api'], catalog });
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', '.current-effort'), 'other\n');
  const r = assemble({ rootDir: root, slug: 'thing', keys: ['api'], catalog });
  assert.equal(readFileSync(join(root, 'workspace', '.current-effort'), 'utf8').trim(), 'thing');
  assert.ok(r.warnings.some((w) => w.includes('other')));
  rmSync(dir, { recursive: true });
});

test('resume: checks out the effort branch that a prior session pushed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asm-'));
  const remote = bareRemote(dir, 'api', { effortBranch: 'feat/thing' });
  const root = join(dir, 'root');
  mkdirSync(root, { recursive: true });
  const catalog = { repos: { api: entry(remote) } };
  assemble({ rootDir: root, slug: 'thing', keys: ['api'], catalog });
  const out = log(join(root, 'workspace', 'api'));
  assert.match(out, /work from a prior session/);
  rmSync(dir, { recursive: true });
});

test('a second effort in a reused workspace branches from the default branch, not the first effort', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asm-'));
  const remote = bareRemote(dir, 'api');
  const root = join(dir, 'root');
  mkdirSync(root, { recursive: true });
  const catalog = { repos: { api: entry(remote) } };

  assemble({ rootDir: root, slug: 'effort-a', keys: ['api'], catalog });
  const wsApi = join(root, 'workspace', 'api');
  execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'effort-a work'], { cwd: wsApi });

  assemble({ rootDir: root, slug: 'effort-b', keys: ['api'], catalog });
  assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: wsApi }).toString().trim(), 'feat/effort-b');
  assert.doesNotMatch(log(wsApi), /effort-a work/);
  rmSync(dir, { recursive: true });
});

test('a readonly repo is detached on the default branch and refuses commits and pushes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asm-'));
  const remote = bareRemote(dir, 'sdk');
  const root = join(dir, 'root');
  mkdirSync(root, { recursive: true });
  const catalog = { repos: { sdk: entry(remote, { readonly: true }) } };
  const r = assemble({ rootDir: root, slug: 'thing', keys: ['sdk'], catalog });
  const ws = join(root, 'workspace', 'sdk');

  assert.deepEqual(r.readonly, ['sdk']);
  assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: ws }).toString().trim(), '');
  assert.equal(
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ws }).toString(),
    execFileSync('git', ['rev-parse', 'main'], { cwd: remote }).toString()
  );
  assert.throws(() => git(ws, 'rev-parse', '--verify', '--quiet', 'refs/heads/feat/thing'));
  assert.throws(() => git(ws, '-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'nope'));
  assert.equal(execFileSync('git', ['remote', 'get-url', '--push', 'origin'], { cwd: ws }).toString().trim(), 'no-push://readonly');
  assert.equal(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ws }).toString().trim(), remote);
  rmSync(dir, { recursive: true });
});

test('re-assembling a readonly repo refreshes it to the latest default branch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asm-'));
  const remote = bareRemote(dir, 'sdk');
  const root = join(dir, 'root');
  mkdirSync(root, { recursive: true });
  const catalog = { repos: { sdk: entry(remote, { readonly: true }) } };
  assemble({ rootDir: root, slug: 'thing', keys: ['sdk'], catalog });

  const seed = join(dir, 'seed-sdk');
  git(seed, '-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'upstream moved');
  git(seed, 'push', 'origin', 'main');

  const r2 = assemble({ rootDir: root, slug: 'thing', keys: ['sdk'], catalog });
  assert.deepEqual(r2.fetched, ['sdk']);
  assert.match(log(join(root, 'workspace', 'sdk')), /upstream moved/);
  rmSync(dir, { recursive: true });
});

test('a repo flipped from readonly back to writable loses its guards', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asm-'));
  const remote = bareRemote(dir, 'sdk');
  const root = join(dir, 'root');
  mkdirSync(root, { recursive: true });
  assemble({ rootDir: root, slug: 'thing', keys: ['sdk'], catalog: { repos: { sdk: entry(remote, { readonly: true }) } } });
  assemble({ rootDir: root, slug: 'thing', keys: ['sdk'], catalog: { repos: { sdk: entry(remote) } } });
  const ws = join(root, 'workspace', 'sdk');

  assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: ws }).toString().trim(), 'feat/thing');
  git(ws, '-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'now allowed');
  assert.equal(execFileSync('git', ['remote', 'get-url', '--push', 'origin'], { cwd: ws }).toString().trim(), remote);
  rmSync(dir, { recursive: true });
});

test('a non-https/ssh url in repos.yml is refused (via loadCatalog)', () => {
  const { dir, root } = setup();
  writeFileSync(join(root, 'repos.yml'), `repos:
  api:
    url: file:///tmp/evil
    default_branch: main
    domain: backend
    summary: s
    responsibilities: [x]
`);
  assert.throws(() => assemble({ rootDir: root, slug: 'thing', keys: ['api'] }), /https:\/\/ or git@/);
  rmSync(dir, { recursive: true });
});
