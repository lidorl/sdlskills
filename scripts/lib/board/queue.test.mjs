import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEfforts, rank, overlaps } from './queue.mjs';

const NOW = new Date('2026-11-20T12:00:00.000Z');
const TTL = 4 * 3600e3;
const OPTS = { now: NOW, ttlMs: TTL, openRequestIds: new Set() };
const e = (slug, o = {}) => ({
  slug, status: 'ACCEPTED', priority: 'Medium', severity: undefined, date: '2026-01-01',
  fm: {}, repos: [], security: false, ...o,
});
const slugs = (list) => list.map((x) => x.slug);

test('rank applies severity, in-flight, priority, age in that order', () => {
  const list = [
    e('old-low', { priority: 'Low', date: '2025-01-01' }),
    e('new-high', { priority: 'High', date: '2026-05-01' }),
    e('old-high', { priority: 'High', date: '2025-06-01' }),
    e('nodate-high', { priority: 'High', date: undefined }),
    e('flight-low', { status: 'IN_PROGRESS', priority: 'Low' }),
    e('flight-high', { status: 'DESIGNED', priority: 'High' }),
    e('crit', { severity: 'Critical', priority: 'Low' }),
    e('sec', { security: true, status: 'IN_PROGRESS', priority: 'High' }),
    e('weird', { priority: 'Urgent', date: '2024-01-01' }),
  ];
  assert.deepEqual(slugs(rank(list, OPTS)), [
    'sec', 'crit', 'flight-high', 'flight-low', 'nodate-high', 'old-high', 'new-high', 'old-low', 'weird',
  ]);
});

test('rank skips live claims and awaiting-open efforts, keeps stale and answered-awaiting', () => {
  const fresh = '2026-11-20T11:00:00Z';
  const old = '2026-11-19T00:00:00Z';
  const list = [
    e('live', { fm: { claimed_by: 'a-1', claimed_at: fresh } }),
    e('stale', { fm: { claimed_by: 'a-1', claimed_at: old } }),
    e('open-wait', { fm: { awaiting: 'r1' } }),
    e('answered-wait', { fm: { awaiting: 'r2' } }),
    e('free'),
  ];
  const out = rank(list, { ...OPTS, openRequestIds: new Set(['r1']) });
  assert.deepEqual(slugs(out).sort(), ['answered-wait', 'free', 'stale']);
});

test('rank excludes PARKED, REJECTED, IMPLEMENTED', () => {
  const list = ['PARKED', 'REJECTED', 'IMPLEMENTED', 'DRAFT'].map((s) => e(s, { status: s }));
  list.push(e('ok'));
  assert.deepEqual(slugs(rank(list, OPTS)), ['ok']);
});

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'queue-'));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  return root;
}

test('loadEfforts reads feat-reqs, design repos and security flags', () => {
  const root = tree({
    'docs/feat-req/a.md': '---\nstatus: DESIGNED\npriority: High\ndate: 2026-02-03\ntags: [security]\n---\n# a\n',
    'docs/feat-req/b.md': '---\nstatus: ACCEPTED\nsecurity: true\nseverity: Critical\n---\n# b\n',
    'docs/design/a.md': '---\nrepos: [api, web]\n---\n# d\n',
  });
  const { efforts, problems } = loadEfforts(root);
  assert.deepEqual(problems, []);
  const a = efforts.find((x) => x.slug === 'a');
  assert.deepEqual(a.repos, ['api', 'web']);
  assert.equal(a.security, true);
  assert.equal(a.priority, 'High');
  assert.equal(a.date, '2026-02-03');
  const b = efforts.find((x) => x.slug === 'b');
  assert.deepEqual(b.repos, []);
  assert.equal(b.severity, 'Critical');
  assert.equal(b.security, true);
});

test('a feat-req with broken frontmatter is reported in problems and skipped', () => {
  const root = tree({
    'docs/feat-req/good.md': '---\nstatus: ACCEPTED\n---\n# g\n',
    'docs/feat-req/bad.md': '---\nstatus: [oops\n---\n# b\n',
  });
  const { efforts, problems } = loadEfforts(root);
  assert.deepEqual(efforts.map((x) => x.slug), ['good']);
  assert.equal(problems.length, 1);
  assert.match(problems[0].file, /bad\.md$/);
  assert.ok(problems[0].message);
});

test('loadEfforts on a tree without docs/feat-req is empty', () => {
  assert.deepEqual(loadEfforts(tree({})), { efforts: [], problems: [] });
});

test('overlaps names the other effort and only shared writable repos', () => {
  const live = { claimed_by: 'x-1', claimed_at: '2026-11-20T11:00:00Z' };
  const a = e('a', { repos: ['api', 'docs'] });
  const b = e('b', { repos: ['api', 'docs', 'web'], fm: live });
  const c = e('c', { repos: ['api'] }); // not claimed
  const d = e('d', { repos: ['api'], fm: { claimed_by: 'x', claimed_at: '2026-11-01T00:00:00Z' } }); // stale
  const f = e('f', { repos: ['web'], fm: live }); // no shared repo
  const g = e('g', { repos: ['docs'], fm: live }); // only readonly shared
  const opts = { now: NOW, ttlMs: TTL, readonlyKeys: new Set(['docs']) };
  assert.deepEqual(overlaps(a, [a, b, c, d, f, g], opts), [{ slug: 'b', repos: ['api'] }]);
});
