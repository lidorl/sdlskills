import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorEnabled, makeStyle } from './style.mjs';
import { formatReport } from './report.mjs';

const tty = { isTTY: true };
const pipe = { isTTY: false };

test('colors are on for a terminal, off for a pipe', () => {
  assert.equal(colorEnabled(tty, {}), true);
  assert.equal(colorEnabled(pipe, {}), false);
});

test('NO_COLOR turns colors off even on a terminal', () => {
  assert.equal(colorEnabled(tty, { NO_COLOR: '1' }), false);
});

test('TERM=dumb turns colors off', () => {
  assert.equal(colorEnabled(tty, { TERM: 'dumb' }), false);
});

test('FORCE_COLOR turns colors on for a pipe, unless it is 0', () => {
  assert.equal(colorEnabled(pipe, { FORCE_COLOR: '1' }), true);
  assert.equal(colorEnabled(pipe, { FORCE_COLOR: '0' }), false);
});

test('an enabled style wraps text in ANSI codes; a disabled one returns it unchanged', () => {
  assert.equal(makeStyle(true).green('ok'), '\x1b[32mok\x1b[39m');
  assert.equal(makeStyle(false).green('ok'), 'ok');
  for (const name of ['bold', 'dim', 'red', 'green', 'yellow', 'cyan']) {
    assert.equal(typeof makeStyle(true)[name], 'function', name);
  }
});

test('the report is plain by default and colored when given a style', () => {
  const args = { title: 't', actions: ['did x'], warnings: ['careful'], nextSteps: ['go'] };
  assert.doesNotMatch(formatReport(args), /\x1b/);
  const out = formatReport({ ...args, style: makeStyle(true) });
  assert.match(out, /\x1b\[32m✓/);
  assert.match(out, /\x1b\[33m!/);
  assert.match(out, /\x1b\[1mDone/);
});
