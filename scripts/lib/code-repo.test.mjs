import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { looksLikeCodeRepo } from './code-repo.mjs';

/** A temp dir with the given files/dirs (a trailing "/" makes a directory). */
function repo(entries = [], { git = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'coderepo-'));
  if (git) mkdirSync(join(dir, '.git'));
  for (const e of entries) {
    const [path, content = ''] = Array.isArray(e) ? e : [e];
    if (path.endsWith('/')) mkdirSync(join(dir, path), { recursive: true });
    else {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
  }
  return dir;
}

test('plain git repo with src/, app/ or lib/ is code', () => {
  for (const d of ['src/', 'app/', 'lib/']) {
    const dir = repo([d]);
    const r = looksLikeCodeRepo(dir);
    assert.equal(r.isCode, true, d);
    assert.ok(r.reason.includes(d.replace('/', '')), r.reason);
    rmSync(dir, { recursive: true });
  }
});

test('build manifests are code', () => {
  for (const f of ['pyproject.toml', 'go.mod', 'pom.xml', 'Cargo.toml', 'App.csproj']) {
    const dir = repo([f]);
    const r = looksLikeCodeRepo(dir);
    assert.equal(r.isCode, true, f);
    assert.ok(r.reason.includes(f), r.reason);
    rmSync(dir, { recursive: true });
  }
});

test('package.json with dependencies beyond yaml is code', () => {
  const cases = [
    [{ dependencies: { express: '^4' } }, true],
    [{ dependencies: { yaml: '^2.5.0' } }, false],
    [{ name: 'x' }, false],
  ];
  for (const [pkg, expected] of cases) {
    const dir = repo([['package.json', JSON.stringify(pkg)]]);
    assert.equal(looksLikeCodeRepo(dir).isCode, expected, JSON.stringify(pkg));
    rmSync(dir, { recursive: true });
  }
});

test('not a git repo is never flagged', () => {
  const dir = repo(['src/', 'go.mod'], { git: false });
  assert.deepEqual(looksLikeCodeRepo(dir), { isCode: false, reason: '' });
  rmSync(dir, { recursive: true });
});

test('a directory that already holds the kit is never flagged', () => {
  for (const skills of ['.claude/skills', '.github/skills']) {
    const dir = repo(['src/', [`${skills}/write-design-doc/SKILL.md`, 'x']]);
    assert.equal(looksLikeCodeRepo(dir).isCode, false, skills);
    rmSync(dir, { recursive: true });
  }
});

test('empty git repo is not code', () => {
  const dir = repo();
  assert.deepEqual(looksLikeCodeRepo(dir), { isCode: false, reason: '' });
  rmSync(dir, { recursive: true });
});
