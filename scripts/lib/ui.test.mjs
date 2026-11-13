import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createUi } from './ui.mjs';

const CHOICES = [
  { label: 'Claude Code', value: 'claude', key: 'c', aliases: ['claude code'] },
  { label: 'GitHub Copilot', value: 'copilot', key: 'g', aliases: ['github copilot'] },
];

/** A fake terminal: isTTY streams that record output and track raw mode. */
function terminal({ tty }) {
  const input = new PassThrough();
  const output = new PassThrough();
  if (tty) {
    input.isTTY = true;
    output.isTTY = true;
    input.raw = false;
    input.setRawMode = (v) => (input.raw = v);
  }
  let text = '';
  output.on('data', (c) => (text += c));
  return { input, output, text: () => text };
}

const KEY = { down: '\x1b[B', up: '\x1b[A', enter: '\r', esc: '\x1b', ctrlC: '\x03' };

/** Starts a select and feeds it keys; returns the result. */
async function pick(keys, opts = {}) {
  const t = terminal({ tty: true });
  const ui = createUi({ input: t.input, output: t.output, env: opts.env ?? {} });
  const p = ui.select({ message: 'Which tool?', choices: CHOICES, ...opts.select });
  for (const k of keys) t.input.write(k);
  const value = await p;
  return { value, t, ui };
}

test('interactive: Enter picks the highlighted (first) choice', async () => {
  assert.equal((await pick([KEY.enter])).value, 'claude');
});

test('interactive: down then Enter picks the second; up wraps from the first to the last', async () => {
  assert.equal((await pick([KEY.down, KEY.enter])).value, 'copilot');
  assert.equal((await pick([KEY.up, KEY.enter])).value, 'copilot');
  assert.equal((await pick([KEY.down, KEY.down, KEY.enter])).value, 'claude');
});

test('interactive: j/k and number keys also move', async () => {
  assert.equal((await pick(['j', KEY.enter])).value, 'copilot');
  assert.equal((await pick(['j', 'k', KEY.enter])).value, 'claude');
  assert.equal((await pick(['2', KEY.enter])).value, 'copilot');
});

test('interactive: `initial` sets the starting highlight', async () => {
  assert.equal((await pick([KEY.enter], { select: { initial: 1 } })).value, 'copilot');
});

test("interactive: a choice's key picks it immediately, no Enter needed", async () => {
  assert.equal((await pick(['g'])).value, 'copilot');
  assert.equal((await pick(['C'])).value, 'claude');
});

test('interactive: Esc and Ctrl-C cancel with null', async () => {
  assert.equal((await pick([KEY.esc])).value, null);
  assert.equal((await pick([KEY.ctrlC])).value, null);
});

test('interactive: raw mode is on while choosing and restored after', async () => {
  const t = terminal({ tty: true });
  const ui = createUi({ input: t.input, output: t.output, env: {} });
  const p = ui.select({ message: 'Which tool?', choices: CHOICES });
  assert.equal(t.input.raw, true);
  t.input.write(KEY.enter);
  await p;
  assert.equal(t.input.raw, false);
});

test('interactive: shows the choices, then collapses to a one-line summary', async () => {
  const { t } = await pick([KEY.down, KEY.enter]);
  assert.match(t.text(), /Claude Code/);
  assert.match(t.text(), /GitHub Copilot/);
  assert.match(t.text(), /✔.*Which tool\?.*GitHub Copilot/);
});

test('interactive: colors follow NO_COLOR', async () => {
  assert.match((await pick([KEY.enter])).t.text(), /\x1b\[36m/);
  assert.doesNotMatch((await pick([KEY.enter], { env: { NO_COLOR: '1' } })).t.text(), /\x1b\[36m/);
});

test('interactive ask: Tab completes using the given completer', async () => {
  const t = terminal({ tty: true });
  const ui = createUi({ input: t.input, output: t.output, env: {} });
  const p = ui.ask('Path: ', { completer: (line) => [line === 'be' ? ['beta/'] : [], line] });
  t.input.write('be\t');
  await new Promise((r) => setTimeout(r, 50)); // completion settles asynchronously, as it does for a human
  t.input.write('\r');
  assert.equal(await p, 'beta/');
});

/** Non-terminal: numbered fallback, answers read from lines. */
async function typed(answers, opts = {}) {
  const t = terminal({ tty: false });
  for (const a of answers) t.input.write(a + '\n');
  if (opts.end) t.input.end();
  const ui = createUi({ input: t.input, output: t.output, env: {} });
  const value = await ui.select({ message: 'Which tool will you use?', choices: CHOICES, ...opts.select });
  ui.close();
  return { value, text: t.text() };
}

test('fallback: a number, a key, a value, a label or an alias all work', async () => {
  for (const a of ['1', 'c', 'claude', 'Claude Code', '  CLAUDE CODE ']) assert.equal((await typed([a])).value, 'claude', a);
  for (const a of ['2', 'g', 'copilot', 'github copilot']) assert.equal((await typed([a])).value, 'copilot', a);
});

test('fallback: lists the numbered choices and asks again on a bad answer', async () => {
  const { value, text } = await typed(['', 'vim', '2']);
  assert.equal(value, 'copilot');
  assert.match(text, /1\) Claude Code/);
  assert.match(text, /2\) GitHub Copilot/);
  assert.match(text, /Please type 1 or 2/);
});

test('fallback: an empty answer takes `initial` when there is one', async () => {
  assert.equal((await typed([''], { select: { initial: 1 } })).value, 'copilot');
});

test('fallback: closed input returns null', async () => {
  assert.equal((await typed([], { end: true })).value, null);
});
