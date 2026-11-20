import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDoc, setFields, appendToSection, FrontmatterError } from './frontmatter.mjs';

test('setFields adds, changes and deletes keys, keeps body and key order', () => {
  const src = '---\ndate: 2026-11-19\nstatus: ACCEPTED\npriority: High\n---\n\n# T\n\nbody `x`\n';
  const out = setFields(src, { status: 'DESIGNED', claimed_by: 'lidorl-7f3a9c', priority: null });
  assert.equal(out, '---\ndate: 2026-11-19\nstatus: DESIGNED\nclaimed_by: lidorl-7f3a9c\n---\n\n# T\n\nbody `x`\n');
});
test('setFields writes ISO timestamps as plain scalars', () => {
  const out = setFields('---\na: 1\n---\nB', { claimed_at: '2026-11-20T10:00:00Z' });
  assert.equal(out, '---\na: 1\nclaimed_at: 2026-11-20T10:00:00Z\n---\nB');
});
test('setFields creates frontmatter when absent', () => {
  assert.equal(setFields('# T\n', { a: 'x' }), '---\na: x\n---\n# T\n');
});
test('parseDoc reads flat frontmatter', () => {
  assert.deepEqual(parseDoc('---\na: 1\nb: x\n---\nB').data, { a: 1, b: 'x' });
});
test('parseDoc returns body and empty data without frontmatter', () => {
  assert.deepEqual(parseDoc('# T\n'), { data: {}, body: '# T\n' });
});
test('parseDoc throws FrontmatterError on broken YAML', () => {
  assert.throws(() => parseDoc('---\na: [1,\n---\n'), FrontmatterError);
});
test('appendToSection creates ## Decisions at the end, then appends to it', () => {
  let t = '---\na: 1\n---\n# T\n\n## Triage\nx\n';
  t = appendToSection(t, 'Decisions', '- one');
  t = appendToSection(t, 'Decisions', '- two');
  assert.match(t, /## Triage\nx\n\n## Decisions\n- one\n- two\n$/);
});
test('appendToSection inserts before the next ## heading when the section is in the middle', () => {
  const t = appendToSection('# T\n\n## Decisions\n- one\n\n## Other\ny\n', 'Decisions', '- two');
  assert.match(t, /## Decisions\n- one\n- two\n\n## Other/);
});
test('appendToSection ignores headings inside code fences', () => {
  const src = '# T\n\n```\n## Decisions\n```\n';
  const t = appendToSection(src, 'Decisions', '- one');
  assert.equal(t, '# T\n\n```\n## Decisions\n```\n\n## Decisions\n- one\n');
});
