import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { chooseTool } from './choose-tool.mjs';

async function choose(answers, { end = false } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (c) => (text += c));
  for (const a of answers) input.write(a + '\n');
  if (end) input.end();
  const tool = await chooseTool({ input, output });
  return { tool, text };
}

test('1 or "claude" picks Claude Code', async () => {
  assert.equal((await choose(['1'])).tool, 'claude');
  assert.equal((await choose(['Claude'])).tool, 'claude');
});

test('2 or "copilot" picks GitHub Copilot', async () => {
  assert.equal((await choose(['2'])).tool, 'copilot');
  assert.equal((await choose(['  copilot '])).tool, 'copilot');
});

test('an unrecognised answer asks again', async () => {
  const { tool, text } = await choose(['', 'vim', '2']);
  assert.equal(tool, 'copilot');
  assert.match(text, /Please type 1 or 2/);
});

test('names both tools in the question', async () => {
  const { text } = await choose(['1']);
  assert.match(text, /Claude Code/);
  assert.match(text, /GitHub Copilot/);
});

test('closed input returns null', async () => {
  assert.equal((await choose([], { end: true })).tool, null);
});
