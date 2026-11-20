import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { DEFAULT_CONFIG_YAML, parseDuration, loadConfig, validateConfig, boardEnabled } from './config.mjs';

function tmp() {
  const root = mkdtempSync(join(tmpdir(), 'board-config-'));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}
function withConfig(text) {
  const t = tmp();
  mkdirSync(join(t.root, 'board'));
  if (text !== null) writeFileSync(join(t.root, 'board', 'config.yml'), text);
  return t;
}

test('parseDuration', () => {
  assert.equal(parseDuration('4h'), 4 * 3600e3);
  assert.equal(parseDuration('30s'), 30e3);
  assert.equal(parseDuration('5m'), 300e3);
  assert.equal(parseDuration('2d'), 2 * 86400e3);
  assert.throws(() => parseDuration('4 hours'));
  assert.throws(() => parseDuration('1.5h'));
  assert.throws(() => parseDuration(30));
  assert.throws(() => parseDuration(''));
});

test('loadConfig falls back per key', () => {
  const t = withConfig('lease_ttl: 1h\n');
  try {
    const c = loadConfig(t.root);
    assert.equal(c.leaseTtlMs, 3600e3);
    assert.equal(c.idlePollMs, 60e3);
    assert.equal(c.phaseTimeoutMs, 3 * 3600e3);
    assert.equal(c.watchIntervalMs, 30e3);
    assert.deepEqual(c.backoffMs, [300e3, 900e3, 3600e3]);
  } finally { t.done(); }
});

test('loadConfig with no file returns defaults', () => {
  const t = withConfig(null);
  try {
    const c = loadConfig(t.root);
    assert.equal(c.leaseTtlMs, 4 * 3600e3);
    assert.equal(c.idlePollMs, 60e3);
  } finally { t.done(); }
});

test('DEFAULT_CONFIG_YAML parses to the defaults', () => {
  const none = withConfig(null);
  const dflt = withConfig(DEFAULT_CONFIG_YAML);
  try {
    assert.deepEqual(loadConfig(dflt.root), loadConfig(none.root));
    assert.deepEqual(validateConfig(parse(DEFAULT_CONFIG_YAML)), []);
  } finally { none.done(); dflt.done(); }
});

test('loadConfig throws naming board/config.yml on broken YAML or bad values', () => {
  for (const text of ['lease_ttl: [unclosed\n', 'lease_ttl: soon\n', 'colour: 1\n']) {
    const t = withConfig(text);
    try {
      assert.throws(() => loadConfig(t.root), /board\/config\.yml/);
    } finally { t.done(); }
  }
});

test('validateConfig flags unknown keys and bad durations', () => {
  const p = validateConfig({ lease_ttl: 'soon', colour: 1 });
  assert.equal(p.length, 2);
  assert.ok(p.some((s) => s.startsWith('lease_ttl: ')));
  assert.ok(p.some((s) => s.startsWith('colour: ')));
});

test('validateConfig checks backoff shape', () => {
  assert.equal(validateConfig({ backoff: '5m' }).length, 1);
  assert.equal(validateConfig({ backoff: [] }).length, 1);
  assert.equal(validateConfig({ backoff: ['5m', 'x'] }).length, 1);
  assert.deepEqual(validateConfig({ backoff: ['5m'] }), []);
  assert.deepEqual(validateConfig({}), []);
});

test('boardEnabled is false without board/ and true with it', () => {
  const t = tmp();
  try {
    assert.equal(boardEnabled(t.root), false);
    writeFileSync(join(t.root, 'board'), 'file');
    assert.equal(boardEnabled(t.root), false);
    rmSync(join(t.root, 'board'));
    mkdirSync(join(t.root, 'board'));
    assert.equal(boardEnabled(t.root), true);
  } finally { t.done(); }
});

test('zero durations are refused: parseDuration, validateConfig and loadConfig', () => {
  for (const z of ['0s', '0m', '0h', '0d', '00s']) assert.throws(() => parseDuration(z), /greater than 0/, z);
  assert.deepEqual(validateConfig({ lease_ttl: '0s' }), ['lease_ttl: invalid duration "0s" (must be greater than 0)']);
  assert.equal(validateConfig({ idle_poll: '0s', backoff: ['5m', '0m'] }).length, 2);
  const t = withConfig('lease_ttl: 0s\n');
  try { assert.throws(() => loadConfig(t.root), /board\/config\.yml: lease_ttl/); } finally { t.done(); }
});
