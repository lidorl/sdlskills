import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { install, SKILLS, DOCS_DIRS } from './install-sdlc.mjs';
import { COPILOT_LAYOUT } from './install-sdlc-copilot.mjs';

const kitRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const PROCESS = '.github/instructions/sdlc-process.instructions.md';
const STACK = '.github/instructions/sdlc-stack.instructions.md';
const HOOK = '.github/hooks/sdlc-status.json';

const run = (targetDir, extra = {}) =>
  install({ kitRoot, targetDir, skipPlugins: true, skipNpm: true, layout: COPILOT_LAYOUT, ...extra });

function target() {
  const dir = mkdtempSync(join(tmpdir(), 'inst-copilot-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

test('vendors the phase skills and the review skills into .github/skills', () => {
  const dir = target();
  run(dir);
  for (const s of [...SKILLS, 'code-review', 'security-review']) {
    assert.ok(existsSync(join(dir, '.github/skills', s, 'SKILL.md')), `skill ${s}`);
  }
  assert.ok(!existsSync(join(dir, '.claude')));
  assert.ok(!existsSync(join(dir, 'CLAUDE.process.md')));
  assert.ok(!existsSync(join(dir, 'CLAUDE.stack.md')));
  for (const d of DOCS_DIRS) assert.ok(existsSync(join(dir, 'docs', d, '.gitkeep')), `docs/${d}`);
  rmSync(dir, { recursive: true });
});

test('installs the contract and stack doc as always-applied instruction files', () => {
  const dir = target();
  run(dir);
  for (const f of [PROCESS, STACK]) {
    assert.match(readFileSync(join(dir, f), 'utf8'), /^---\napplyTo: '\*\*'\n---\n/, f);
  }
  rmSync(dir, { recursive: true });
});

test('leaves no Claude-specific reference in anything it writes', () => {
  const dir = target();
  run(dir);
  const residue = /Claude|CLAUDE\.md|CLAUDE\.process|CLAUDE\.stack\.md|\.claude|superpowers:|`Stop`/;
  const files = readdirSync(join(dir, '.github'), { recursive: true })
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(dir, '.github', f));
  assert.ok(files.length >= SKILLS.length + 4);
  for (const f of files) {
    const hit = readFileSync(f, 'utf8')
      .split('\n')
      .find((l) => residue.test(l));
    assert.equal(hit, undefined, `${f}: ${hit}`);
  }
  rmSync(dir, { recursive: true });
});

test('points skills at the Copilot paths and bare superpowers skill names', () => {
  const dir = target();
  run(dir);
  const setup = readFileSync(join(dir, '.github/skills/setup-sdlc/SKILL.md'), 'utf8');
  assert.ok(setup.includes('Kit skills present in `.github/skills/`'));
  assert.ok(setup.includes('Autonomy Policy block in `.github/copilot-instructions.md`'));
  assert.ok(setup.includes(HOOK));
  const plan = readFileSync(join(dir, '.github/skills/write-execution-plan/SKILL.md'), 'utf8');
  assert.ok(plan.includes('wrapper around `writing-plans`'));
  rmSync(dir, { recursive: true });
});

test('writes the status hook on agentStop', () => {
  const dir = target();
  run(dir);
  const hook = JSON.parse(readFileSync(join(dir, HOOK), 'utf8'));
  assert.equal(hook.version, 1);
  const [entry] = hook.hooks.agentStop;
  assert.equal(entry.type, 'command');
  assert.match(entry.bash, /render-status\.mjs/);
  assert.match(entry.powershell, /render-status\.mjs/);
  rmSync(dir, { recursive: true });
});

test('re-run refreshes kit files, keeps the stack doc and copilot-instructions.md', () => {
  const dir = target();
  run(dir);
  mkdirSync(join(dir, '.github'), { recursive: true });
  writeFileSync(join(dir, STACK), 'MINE\n');
  writeFileSync(join(dir, '.github/copilot-instructions.md'), 'AUTONOMY\n');
  writeFileSync(join(dir, PROCESS), 'STALE\n');
  run(dir);
  assert.equal(readFileSync(join(dir, STACK), 'utf8'), 'MINE\n');
  assert.equal(readFileSync(join(dir, '.github/copilot-instructions.md'), 'utf8'), 'AUTONOMY\n');
  assert.notEqual(readFileSync(join(dir, PROCESS), 'utf8'), 'STALE\n');
  rmSync(dir, { recursive: true });
});

test('leaves an existing Claude install untouched', () => {
  const dir = target();
  install({ kitRoot, targetDir: dir, skipPlugins: true, skipNpm: true });
  const before = readFileSync(join(dir, '.claude/skills/close-out/SKILL.md'), 'utf8');
  run(dir);
  assert.equal(readFileSync(join(dir, '.claude/skills/close-out/SKILL.md'), 'utf8'), before);
  assert.ok(existsSync(join(dir, 'CLAUDE.process.md')));
  rmSync(dir, { recursive: true });
});

test('does not copy either installer into the target', () => {
  const dir = target();
  run(dir);
  const scripts = readdirSync(join(dir, 'scripts'));
  assert.ok(!scripts.some((s) => s.startsWith('install-sdlc')), scripts.join(','));
  assert.ok(scripts.includes('render-status.mjs'));
  rmSync(dir, { recursive: true });
});

test('dry-run touches nothing', () => {
  const dir = target();
  const r = run(dir, { dryRun: true });
  assert.ok(!existsSync(join(dir, '.github')));
  assert.ok(!existsSync(join(dir, 'package.json')));
  assert.ok(r.actions.every((a) => a.startsWith('[dry-run]')));
  rmSync(dir, { recursive: true });
});

test('tells the user how to get superpowers when plugins are skipped', () => {
  const dir = target();
  const r = run(dir);
  assert.ok(r.nextSteps.some((n) => n.includes('copilot plugin install superpowers@superpowers-marketplace')));
  assert.ok(r.nextSteps.some((n) => n.includes('chat.plugins.enabled')));
  rmSync(dir, { recursive: true });
});
