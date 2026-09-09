import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { install, SKILLS, DOCS_DIRS } from './install-sdlc.mjs';

const kitRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const opts = (targetDir, extra = {}) => ({
  kitRoot,
  targetDir,
  skipPlugins: true,
  skipNpm: true,
  ...extra,
});

function target() {
  const dir = mkdtempSync(join(tmpdir(), 'inst-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

test('scaffolds skills, scripts, process doc, and docs skeleton', () => {
  const dir = target();
  install(opts(dir));

  for (const s of SKILLS) assert.ok(existsSync(join(dir, '.claude/skills', s, 'SKILL.md')), `skill ${s}`);
  assert.ok(existsSync(join(dir, 'scripts/render-status.mjs')));
  assert.ok(existsSync(join(dir, 'scripts/lib/catalog.mjs')));
  assert.ok(existsSync(join(dir, 'CLAUDE.process.md')));
  for (const d of DOCS_DIRS) assert.ok(existsSync(join(dir, 'docs', d, '.gitkeep')), `docs/${d}`);

  rmSync(dir, { recursive: true });
});

test('does not copy the installer into the target', () => {
  const dir = target();
  install(opts(dir));
  assert.ok(!existsSync(join(dir, 'scripts/install-sdlc.mjs')));
  assert.ok(!existsSync(join(dir, 'scripts/install-sdlc.test.mjs')));
  rmSync(dir, { recursive: true });
});

test('creates package.json with the fields the kit needs', () => {
  const dir = target();
  install(opts(dir));
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.dependencies.yaml, '^2.5.0');
  assert.equal(pkg.scripts.status, 'node scripts/render-status.mjs');
  rmSync(dir, { recursive: true });
});

test('merges into an existing package.json without clobbering user fields', () => {
  const dir = target();
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'my-app', scripts: { dev: 'vite' }, dependencies: { react: '^18' } }, null, 2),
  );
  install(opts(dir));
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'my-app');
  assert.equal(pkg.scripts.dev, 'vite');
  assert.equal(pkg.dependencies.react, '^18');
  assert.equal(pkg.dependencies.yaml, '^2.5.0');
  assert.equal(pkg.scripts.status, 'node scripts/render-status.mjs');
  rmSync(dir, { recursive: true });
});

test('appends kit lines to an existing .gitignore, preserving user entries and not duplicating', () => {
  const dir = target();
  writeFileSync(join(dir, '.gitignore'), 'dist/\nnode_modules/\n');
  install(opts(dir));
  const gi = readFileSync(join(dir, '.gitignore'), 'utf8');
  assert.ok(gi.includes('dist/'));
  assert.ok(gi.includes('workspace/'));
  assert.equal(gi.match(/node_modules\//g).length, 1, 'no duplicate node_modules/');
  rmSync(dir, { recursive: true });
});

test('seeds CLAUDE.stack.md but keeps an existing one', () => {
  const dir = target();
  install(opts(dir));
  assert.ok(existsSync(join(dir, 'CLAUDE.stack.md')));

  writeFileSync(join(dir, 'CLAUDE.stack.md'), 'MINE\n');
  install(opts(dir));
  assert.equal(readFileSync(join(dir, 'CLAUDE.stack.md'), 'utf8'), 'MINE\n');
  rmSync(dir, { recursive: true });
});

test('is idempotent — a second run re-vendors skills and changes nothing else', () => {
  const dir = target();
  install(opts(dir));
  const pkgA = readFileSync(join(dir, 'package.json'), 'utf8');
  const giA = readFileSync(join(dir, '.gitignore'), 'utf8');

  const r = install(opts(dir));
  assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), pkgA);
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), giA);
  assert.ok(r.actions.some((a) => a.includes('vendored')));
  rmSync(dir, { recursive: true });
});

test('dry-run touches nothing', () => {
  const dir = target();
  const r = install(opts(dir, { dryRun: true }));
  assert.ok(!existsSync(join(dir, '.claude')));
  assert.ok(!existsSync(join(dir, 'CLAUDE.process.md')));
  assert.ok(!existsSync(join(dir, 'package.json')));
  assert.ok(r.actions.every((a) => a.startsWith('[dry-run]')));
  rmSync(dir, { recursive: true });
});

test('warns when the target is not a git repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inst-'));
  const r = install(opts(dir));
  assert.ok(r.warnings.some((w) => w.includes('not a git repository')));
  rmSync(dir, { recursive: true });
});

test('throws when the target does not exist', () => {
  assert.throws(() => install(opts('/no/such/dir/anywhere')), /does not exist/);
});
