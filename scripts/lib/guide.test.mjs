import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { runGuide } from './guide.mjs';
import { CLAUDE_LAYOUT } from '../install-sdlc.mjs';
import { COPILOT_LAYOUT } from '../install-sdlc-copilot.mjs';

/** Runs the guide with scripted answers; returns { result, text, previews, cwd, base }. */
async function drive(answers, { layout = CLAUDE_LAYOUT, end = false, ...extra } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'guide-'));
  const cwd = join(base, 'acme-api');
  mkdirSync(cwd);
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (c) => (text += c));
  for (const a of answers) input.write(a + '\n');
  if (end) input.end();
  const previews = [];
  const result = await runGuide({
    layout,
    cwd,
    input,
    output,
    available: () => true,
    nodeVersion: '20.0.0',
    preview: (t) => (previews.push(t), ['vendored skills']),
    ...extra,
  });
  return { result, text, previews, cwd, base };
}

const gitRepoWith = (base, name, entry) => {
  const dir = join(base, name);
  mkdirSync(join(dir, '.git'), { recursive: true });
  mkdirSync(join(dir, entry), { recursive: true });
  return dir;
};

test('explains the meta-root and names the tool and the other installer', async () => {
  const { text, base } = await drive(['', 'y'], { layout: COPILOT_LAYOUT });
  assert.match(text, /meta-root/);
  assert.match(text, /GitHub Copilot/);
  assert.match(text, /install-sdlc\.mjs/);
  rmSync(base, { recursive: true });
});

test('stops when a required prerequisite is missing', async () => {
  const { result, text, previews, base } = await drive([], { available: (c) => c !== 'git' });
  assert.equal(result, null);
  assert.match(text, /git-scm\.com/);
  assert.equal(previews.length, 0);
  rmSync(base, { recursive: true });
});

test('continues when only optional prerequisites are missing', async () => {
  const { result, base } = await drive(['', 'y'], { available: (c) => c !== 'gh' });
  assert.equal(typeof result, 'string');
  rmSync(base, { recursive: true });
});

test('empty answer accepts the <name>-workspace default and creates it', async () => {
  const { result, base } = await drive(['', 'y']);
  assert.equal(result, join(base, 'acme-api-workspace'));
  assert.ok(existsSync(result));
  rmSync(base, { recursive: true });
});

test('relative paths with spaces resolve against cwd', async () => {
  const { result, cwd, base } = await drive(['my space/meta', 'y']);
  assert.equal(result, join(cwd, 'my space/meta'));
  rmSync(base, { recursive: true });
});

test('a leading ~ means the home directory', async () => {
  const { result, base } = await drive(['~/x-sdlc-test', 'y'], { dryRun: true });
  assert.equal(result, join(homedir(), 'x-sdlc-test'));
  rmSync(base, { recursive: true });
});

test('asks again when the path is an existing file', async () => {
  const base0 = mkdtempSync(join(tmpdir(), 'guide-file-'));
  const file = join(base0, 'notes.txt');
  writeFileSync(file, 'x');
  const { result, text, base } = await drive([file, '', 'y']);
  assert.match(text, /is a file/);
  assert.equal(result, join(base, 'acme-api-workspace'));
  rmSync(base, { recursive: true });
  rmSync(base0, { recursive: true });
});

test('warns on a code repo and lets the user pick another path', async () => {
  const base0 = mkdtempSync(join(tmpdir(), 'guide-code-'));
  const code = gitRepoWith(base0, 'code', 'src');
  const clean = join(base0, 'clean');
  const { result, text, base } = await drive([code, 'a', clean, 'y']);
  assert.equal(result, clean);
  assert.match(text, /src\//);
  assert.match(text, /code repository/);
  rmSync(base, { recursive: true });
  rmSync(base0, { recursive: true });
});

test('quitting at the code-repo warning returns null and shows no plan', async () => {
  const base0 = mkdtempSync(join(tmpdir(), 'guide-code-'));
  const code = gitRepoWith(base0, 'code', 'src');
  const { result, previews, base } = await drive([code, 'q']);
  assert.equal(result, null);
  assert.equal(previews.length, 0);
  rmSync(base, { recursive: true });
  rmSync(base0, { recursive: true });
});

test('declining the plan returns null and creates nothing', async () => {
  const { result, base } = await drive(['', 'n']);
  assert.equal(result, null);
  assert.equal(existsSync(join(base, 'acme-api-workspace')), false);
  rmSync(base, { recursive: true });
});

test('dryRun creates no directory', async () => {
  const { result, base } = await drive(['', 'y'], { dryRun: true });
  assert.equal(result, join(base, 'acme-api-workspace'));
  assert.equal(existsSync(result), false);
  rmSync(base, { recursive: true });
});

test('closed input mid-prompt resolves null without throwing', async () => {
  const { result, base } = await drive([], { end: true });
  assert.equal(result, null);
  rmSync(base, { recursive: true });
});
