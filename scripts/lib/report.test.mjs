import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatReport } from './report.mjs';

const base = { title: 'install-sdlc', actions: ['vendored 9 skills', 'copied scripts'], warnings: [], nextSteps: ['First', 'Second'] };

test('lists every action under Done', () => {
  const out = formatReport(base);
  assert.match(out, /Done[\s\S]*vendored 9 skills[\s\S]*copied scripts/);
});

test('numbers next steps from 1, in order', () => {
  const out = formatReport(base);
  assert.ok(out.indexOf('1. First') !== -1);
  assert.ok(out.indexOf('1. First') < out.indexOf('2. Second'));
});

test('omits Needs attention when there are no warnings', () => {
  assert.doesNotMatch(formatReport(base), /Needs attention/);
});

test('puts warnings under Needs attention, before Next steps', () => {
  const out = formatReport({ ...base, warnings: ['copilot not on PATH'] });
  assert.ok(out.indexOf('Needs attention') < out.indexOf('copilot not on PATH'));
  assert.ok(out.indexOf('copilot not on PATH') < out.indexOf('Next steps'));
});
