import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { install, SKILLS, DOCS_DIRS, CLAUDE_LAYOUT } from './install-sdlc.mjs';
import { COPILOT_LAYOUT } from './install-sdlc-copilot.mjs';
import { DEFAULT_CONFIG_YAML } from './lib/board/config.mjs';

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

test('recommends git init when the target is not a git repo, without blocking', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inst-'));
  const r = install(opts(dir));
  const w = r.warnings.find((x) => x.includes('not a git repository'));
  assert.ok(w);
  assert.match(w, /recommended/);
  assert.ok(existsSync(join(dir, 'CLAUDE.process.md')));
  rmSync(dir, { recursive: true });
});

test('does not warn about git when the target is a git repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inst-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const r = install(opts(dir));
  assert.ok(!r.warnings.some((x) => x.includes('not a git repository')));
  rmSync(dir, { recursive: true });
});

test('throws when the target does not exist', () => {
  assert.throws(() => install(opts('/no/such/dir/anywhere')), /does not exist/);
});

test('copied scripts are self-contained: every relative import resolves inside the target', () => {
  const dir = target();
  install(opts(dir));
  const scripts = join(dir, 'scripts');
  const missing = [];
  for (const f of readdirSync(scripts, { recursive: true }).filter((f) => f.endsWith('.mjs'))) {
    const file = join(scripts, f);
    for (const m of readFileSync(file, 'utf8').matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      if (!existsSync(resolve(dirname(file), m[1]))) missing.push(`${f} -> ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
  rmSync(dir, { recursive: true });
});

test('installer-only files are not copied, and stale copies from earlier versions are removed', () => {
  const dir = target();
  mkdirSync(join(dir, 'scripts/lib'), { recursive: true });
  writeFileSync(join(dir, 'scripts/lib/guide.mjs'), 'stale');
  writeFileSync(join(dir, 'scripts/install-guided.test.mjs'), 'stale');
  install(opts(dir));
  for (const f of ['lib/guide.mjs', 'lib/ui.mjs', 'lib/prereqs.test.mjs', 'install-guided.test.mjs']) {
    assert.equal(existsSync(join(dir, 'scripts', f)), false, f);
  }
  assert.ok(existsSync(join(dir, 'scripts/lib/catalog.mjs')));
  assert.ok(existsSync(join(dir, 'scripts/lib/is-entry-point.mjs')));
  rmSync(dir, { recursive: true });
});

test('every `marketplace add` uses a source (owner/repo, URL or path), never a bare marketplace name', () => {
  const SOURCE = /^([\w.-]+\/[\w.-]+|https?:\/\/\S+|\.{0,2}\/\S*)$/;
  for (const layout of [CLAUDE_LAYOUT, COPILOT_LAYOUT]) {
    const adds = layout.plugin.commands.filter((c) => c[0] === 'plugin' && c[1] === 'marketplace' && c[2] === 'add');
    assert.ok(adds.length > 0, layout.toolName);
    for (const c of adds) assert.match(c[3], SOURCE, `${layout.toolName}: ${c.join(' ')}`);
  }
});

test('--board scaffolds board/ and seeds config.yml', () => {
  const dir = target();
  const r = install(opts(dir, { board: true }));
  assert.ok(existsSync(join(dir, 'board/workers/.gitkeep')));
  assert.ok(existsSync(join(dir, 'board/requests/.gitkeep')));
  assert.equal(readFileSync(join(dir, 'board/config.yml'), 'utf8'), DEFAULT_CONFIG_YAML);
  assert.ok(r.actions.includes('created board/{workers,requests}/ and board/config.yml'));
  rmSync(dir, { recursive: true });
});

test('no --board: no board/ directory', () => {
  const dir = target();
  install(opts(dir));
  assert.equal(existsSync(join(dir, 'board')), false);
  rmSync(dir, { recursive: true });
});

test('re-run keeps a hand-edited board/config.yml and existing request files', () => {
  const dir = target();
  install(opts(dir, { board: true }));
  writeFileSync(join(dir, 'board/config.yml'), 'lease_ttl: 1h\n');
  writeFileSync(join(dir, 'board/requests/r.md'), 'keep');
  install(opts(dir, { board: true }));
  install(opts(dir));
  assert.equal(readFileSync(join(dir, 'board/config.yml'), 'utf8'), 'lease_ttl: 1h\n');
  assert.equal(readFileSync(join(dir, 'board/requests/r.md'), 'utf8'), 'keep');
  rmSync(dir, { recursive: true });
});

test('bin.sdlc added when absent, kept when present', () => {
  const a = target();
  install(opts(a));
  assert.equal(JSON.parse(readFileSync(join(a, 'package.json'), 'utf8')).bin.sdlc, 'scripts/sdlc.mjs');
  const b = target();
  writeFileSync(join(b, 'package.json'), JSON.stringify({ bin: { sdlc: 'mine.mjs', other: 'o.mjs' } }));
  install(opts(b));
  assert.deepEqual(JSON.parse(readFileSync(join(b, 'package.json'), 'utf8')).bin, { sdlc: 'mine.mjs', other: 'o.mjs' });
  rmSync(a, { recursive: true });
  rmSync(b, { recursive: true });
});

test('vendored scripts include sdlc, the board and worker libs and their fixtures', () => {
  const dir = target();
  install(opts(dir));
  for (const f of ['sdlc.mjs', 'lib/board/cli.mjs', 'lib/board/report.mjs', 'lib/board/fixtures.mjs', 'lib/worker/loop.mjs', 'lib/worker/fixtures', 'lib/is-entry-point.mjs']) {
    assert.ok(existsSync(join(dir, 'scripts', f)), f);
  }
  assert.equal(existsSync(join(dir, 'scripts/lib/report.mjs')), false); // installer-only, same basename as board/report.mjs
  assert.equal(existsSync(join(dir, 'scripts/test-setup.mjs')), false);
  rmSync(dir, { recursive: true });
});

test('copilot layout: --board works the same', () => {
  const dir = target();
  install(opts(dir, { board: true, layout: COPILOT_LAYOUT }));
  assert.ok(existsSync(join(dir, 'board/workers/.gitkeep')));
  assert.equal(readFileSync(join(dir, 'board/config.yml'), 'utf8'), DEFAULT_CONFIG_YAML);
  rmSync(dir, { recursive: true });
});
