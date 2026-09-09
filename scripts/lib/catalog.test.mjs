import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalog, validateCatalog, CatalogError } from './catalog.mjs';

function withRoot(yaml) {
  const dir = mkdtempSync(join(tmpdir(), 'cat-'));
  if (yaml !== undefined) writeFileSync(join(dir, 'repos.yml'), yaml);
  return dir;
}

const VALID = `repos:
  api:
    url: https://github.com/acme/api.git
    default_branch: main
    domain: backend
    summary: The API.
    responsibilities: [offers]
`;

test('loads a valid catalog and fills defaults', () => {
  const dir = withRoot(VALID);
  const cat = loadCatalog(dir);
  assert.equal(cat.repos.api.url, 'https://github.com/acme/api.git');
  assert.deepEqual(cat.repos.api.depends_on, []);
  assert.deepEqual(cat.repos.api.keywords, []);
  assert.equal(cat.repos.api.notes, false);
  rmSync(dir, { recursive: true });
});

test('missing repos.yml throws CatalogError', () => {
  const dir = withRoot(undefined);
  assert.throws(() => loadCatalog(dir), CatalogError);
  rmSync(dir, { recursive: true });
});

test('missing required field is reported', () => {
  const problems = validateCatalog({ repos: { api: { url: 'https://x.git' } } });
  assert.ok(problems.some((p) => p.includes('api') && p.includes('default_branch')));
  assert.ok(problems.some((p) => p.includes('api') && p.includes('domain')));
});

test('non-https/ssh url is rejected', () => {
  const problems = validateCatalog({
    repos: { api: { url: 'file:///tmp/x', default_branch: 'main', domain: 'backend', summary: 's', responsibilities: ['r'] } },
  });
  assert.ok(problems.some((p) => p.includes('url')));
});

test('empty responsibilities is rejected', () => {
  const problems = validateCatalog({
    repos: { api: { url: 'https://x.git', default_branch: 'main', domain: 'backend', summary: 's', responsibilities: [] } },
  });
  assert.ok(problems.some((p) => p.includes('responsibilities')));
});

test('depends_on referencing an unknown key is reported', () => {
  const problems = validateCatalog({
    repos: { api: { url: 'https://x.git', default_branch: 'main', domain: 'backend', summary: 's', responsibilities: ['r'], depends_on: ['ghost'] } },
  });
  assert.ok(problems.some((p) => p.includes('ghost')));
});
