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
  assert.equal(redact('secret="x"', {}), 'secret="[REDACTED]"');
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

test('redaction is linear-time on pathological long lines', () => {
  for (const line of ['a-'.repeat(50000), 'token'.repeat(30000), 'https://'.repeat(20000), '-----BEGIN PRIVATE KEY-----'.repeat(4000), 'password='.repeat(10000)]) {
    const t0 = performance.now();
    redact(line, {});
    const ms = performance.now() - t0;
    assert.ok(ms < 500, `${line.slice(0, 12)} took ${ms}ms`);
  }
});

test('safeExcerpt truncates overlong lines after redacting', () => {
  const r = safeExcerpt('x'.repeat(5000), { env: {} });
  assert.ok(r.text.endsWith(' …[truncated]'));
  assert.equal(r.text.length, 2000 + ' …[truncated]'.length);
});

test('credential headers keep the scheme and hide the credential', () => {
  assert.equal(redact('Authorization: Basic dXNlcjpwYXNz', {}), 'Authorization: Basic [REDACTED]');
  assert.equal(redact('Authorization: Token abc123def', {}), 'Authorization: Token [REDACTED]');
  assert.equal(redact('Proxy-Authorization: Digest username="u", response="r"', {}), 'Proxy-Authorization: Digest [REDACTED]');
  assert.equal(redact('Cookie: sid=abc; other=1', {}), 'Cookie: [REDACTED]');
  assert.equal(redact('Set-Cookie: sid=abc; HttpOnly', {}), 'Set-Cookie: [REDACTED]');
});

test('URL userinfo containing @ or / is fully hidden', () => {
  assert.equal(redact('https://user:p@ss@host/x', {}), 'https://[REDACTED]@host/x');
  assert.equal(redact('https://user:pa/ss@host', {}), 'https://[REDACTED]@host');
});

test('more token shapes', () => {
  assertWhole('sk-proj-' + a(30));
  assertWhole('xoxb-123');
  assertWhole('glpat-' + a(20));
  assertWhole('npm_' + a(36));
  assertWhole('AIza' + a(35));
  assertWhole('sk_live_' + a(24));
  assertWhole('rk_live_' + a(24));
  assert.equal(redact('id AKIA' + 'B'.repeat(16) + '_x', {}), 'id [REDACTED]_x');
});

test('PGP private key block is redacted', () => {
  const pem = ['-----BEGIN PGP PRIVATE KEY BLOCK-----', a(60), '-----END PGP PRIVATE KEY BLOCK-----'].join('\n');
  assert.equal(redact(`x\n${pem}\ny`, {}), 'x\n[REDACTED]\ny');
  assert.equal(redact(['ok', '-----BEGIN PGP PRIVATE KEY BLOCK-----', a(60)].join('\n'), {}), 'ok\n[REDACTED]');
});

test('stray END marker redacts everything before it', () => {
  assert.equal(redact([a(64), a(64), '-----END RSA PRIVATE KEY-----', 'tail'].join('\n'), {}), '[REDACTED]\ntail');
});

test('delimited values do not leak a tail and keep quotes', () => {
  assert.equal(redact('secret=a\\ b', {}), 'secret=[REDACTED]');
  assert.equal(redact('{"password":"a\\"b"}', {}), '{"password":"[REDACTED]"}');
  assert.equal(redact("api_key: 'x\\'y' z", {}), "api_key: '[REDACTED]' z");
  assert.equal(redact('token=abc,def;ghi', {}), 'token=[REDACTED]');
});
