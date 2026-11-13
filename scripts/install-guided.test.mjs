import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { install, planActions, CLAUDE_LAYOUT } from './install-sdlc.mjs';

const kitRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scripts = {
  claude: join(kitRoot, 'scripts/install-sdlc.mjs'),
  copilot: join(kitRoot, 'scripts/install-sdlc-copilot.mjs'),
};
const FLAGS = ['--skip-plugins', '--skip-npm'];

/** Runs an installer with piped stdio, so stdin and stdout are not TTYs. */
const run = (script, args) => spawnSync(process.execPath, [script, ...args], { input: '', encoding: 'utf8', timeout: 60_000 });

const tmp = () => mkdtempSync(join(tmpdir(), 'guided-'));

test('no argument and no TTY prints usage and exits 1, never hangs', () => {
  for (const [name, script] of Object.entries(scripts)) {
    const r = run(script, []);
    assert.equal(r.status, 1, name);
    assert.match(r.stderr, /usage/i, name);
  }
});

test('an argument stays non-interactive and prints Done and Next steps', () => {
  const dir = tmp();
  const r = run(scripts.claude, [dir, ...FLAGS]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Done/);
  assert.match(r.stdout, /Next steps/);
  rmSync(dir, { recursive: true });
});

test('an argument pointing at a code repo warns but still installs', () => {
  const dir = tmp();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  mkdirSync(join(dir, 'src'));
  const r = run(scripts.claude, [dir, ...FLAGS]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Needs attention/);
  assert.match(r.stdout, /code repository/);
  assert.ok(existsSync(join(dir, '.claude/skills/write-design-doc/SKILL.md')));
  rmSync(dir, { recursive: true });
});

test('dry-run tolerates a missing target and creates nothing; a real run still throws', () => {
  const missing = join(tmp(), 'nope');
  const r = install({ kitRoot, targetDir: missing, dryRun: true, skipPlugins: true, skipNpm: true });
  assert.ok(r.actions.length > 0);
  assert.equal(existsSync(missing), false);
  assert.throws(() => install({ kitRoot, targetDir: missing, skipPlugins: true, skipNpm: true }), /does not exist/);
});

test('the last next step tells the user to open the folder in their tool', () => {
  for (const [name, script, tool] of [
    ['claude', scripts.claude, 'Claude Code'],
    ['copilot', scripts.copilot, 'GitHub Copilot'],
  ]) {
    const dir = tmp();
    const r = run(script, [dir, ...FLAGS]);
    assert.match(r.stdout, new RegExp(`Open .* in ${tool} and run \`/setup-sdlc\``), name);
    rmSync(dir, { recursive: true });
  }
});

test('a missing target still fails with exit 1, even with --dry-run', () => {
  const r = run(scripts.claude, [join(tmp(), 'nope'), '--dry-run', ...FLAGS]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not exist/);
});

test('the plan shown before installing has no [dry-run] prefixes', () => {
  const lines = planActions({ kitRoot, targetDir: tmp(), skipPlugins: true, skipNpm: true });
  assert.ok(lines.length > 0);
  for (const l of lines) assert.doesNotMatch(l, /dry-run/, l);
});

test('the plan does not promise a plugin install when the CLI is missing', () => {
  const layout = { ...CLAUDE_LAYOUT, plugin: { ...CLAUDE_LAYOUT.plugin, cli: 'definitely-not-a-cli' } };
  const lines = planActions({ kitRoot, targetDir: tmp(), layout, skipNpm: true });
  assert.equal(lines.some((l) => /superpowers plugin/.test(l)), false, lines.join('\n'));
  const r = install({ kitRoot, targetDir: tmp(), layout, dryRun: true, skipNpm: true });
  assert.equal(r.actions.some((a) => /\[dry-run\] \[dry-run\]/.test(a)), false);
});
