import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, safeExcerpt } from './redact.mjs';

// Tokens are built at runtime so this file holds no secret-shaped literals.
const A = (n) => 'A'.repeat(n);
const a = (n) => 'a1'.repeat(n).slice(0, n);

function assertWhole(token) {
  const out = redact(`before ${token} after`, {});
  assert.ok(!out.includes(token), `token leaked: ${out}`);
  assert.ok(out.includes('[REDACTED]'));
  assert.equal(out, 'before [REDACTED] after');
}

test('whole-token patterns are replaced entirely', () => {
  assertWhole('ghp_' + A(36));
  assertWhole('github_pat_' + a(82));
  for (const p of ['gho_', 'ghu_', 'ghs_', 'ghr_']) assertWhole(p + A(36));
  assertWhole('sk-ant-api03-' + a(40) + '_-' + A(8));
  assertWhole('sk-' + a(48));
  assertWhole('AKIA' + 'B'.repeat(16));
  assertWhole('xoxb-' + '1234567890-' + a(24));
  assertWhole('xoxp-' + '1234567890-' + a(24));
  assertWhole('eyJ' + a(20) + '.eyJ' + a(20) + '.' + a(20));
});

test('PEM private key block becomes a single [REDACTED]', () => {
  const pem = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIE' + a(60), a(64), '-----END RSA PRIVATE KEY-----'].join('\n');
  const out = redact(`x\n${pem}\ny`, {});
  assert.equal(out, 'x\n[REDACTED]\ny');
});

test('Authorization Bearer keeps the header, hides the token', () => {
  const tok = a(30);
  const out = redact(`Authorization: Bearer ${tok}`, {});
  assert.equal(out, 'Authorization: Bearer [REDACTED]');
});

test('URL credentials are hidden, host kept', () => {
  const out = redact('clone https://user:pass@example.com/repo.git failed', {});
  assert.equal(out, 'clone https://[REDACTED]@example.com/repo.git failed');
});

test('key/value secrets keep the key and hide the value', () => {
  assert.equal(redact('password=hunter2', {}), 'password=[REDACTED]');
  assert.equal(redact('api_key: abc', {}), 'api_key: [REDACTED]');
  assert.equal(redact('secret="x"', {}), 'secret=[REDACTED]');
});

test('env values for sensitive names are redacted when bare', () => {
  const env = { MY_SERVICE_TOKEN: 's3cr3tvalue', SHORT_KEY: 'abc', HOME: '/home/someone', DB_PASSWORD: 's3cr3tvalue-longer' };
  const out = redact('fail with s3cr3tvalue-longer and s3cr3tvalue and abc in /home/someone', env);
  assert.equal(out, 'fail with [REDACTED] and [REDACTED] and abc in /home/someone');
});

test('env values with regex metacharacters are escaped', () => {
  const env = { API_SECRET: 'a.b*c+(d)' };
  assert.equal(redact('v=a.b*c+(d) but axb', env), 'v=[REDACTED] but axb');
});

test('plain text is unchanged', () => {
  const text = 'Error: ENOENT no such file\n  at run (file.js:10:5)\nexit code 1';
  assert.equal(redact(text, {}), text);
});

test('safeExcerpt keeps the last 50 lines', () => {
  const lines = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`);
  const r = safeExcerpt(lines.join('\n'), { env: {} });
  assert.equal(r.withheld, false);
  const out = r.text.split('\n');
  assert.equal(out.length, 50);
  assert.equal(out[0], 'line 31');
  assert.equal(out[49], 'line 80');
});

test('safeExcerpt redacts a PEM block whose BEGIN was cut by the line window', () => {
  const lines = ['noise', '-----BEGIN PRIVATE KEY-----', a(64), a(64), '-----END PRIVATE KEY-----', 'tail'];
  const r = safeExcerpt(lines.join('\n'), { maxLines: 4, env: {} });
  assert.ok(!r.text.includes(a(64)));
  assert.equal(r.text, '[REDACTED]\ntail');
});

test('safeExcerpt redacts a dangling BEGIN with no END', () => {
  const text = ['ok', '-----BEGIN OPENSSH PRIVATE KEY-----', a(64), a(64)].join('\n');
  const r = safeExcerpt(text, { env: {} });
  assert.equal(r.text, 'ok\n[REDACTED]');
});

test('safeExcerpt withholds the excerpt when redaction throws', () => {
  const env = new Proxy({}, {
    ownKeys() { throw new Error('boom'); },
    get() { throw new Error('boom'); },
  });
  const r = safeExcerpt('secret stuff', { env });
  assert.deepEqual(r, { text: 'excerpt withheld: redaction failed', withheld: true });
});
