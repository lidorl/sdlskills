/**
 * catalog.mjs — parse and validate repos.yml (the repository catalog).
 * See docs/design/execution-environment.md → "Repository catalog".
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export class CatalogError extends Error {}

const REQUIRED = ['url', 'default_branch', 'domain', 'summary', 'responsibilities'];
const URL_RE = /^(https:\/\/|git@)/;
// A repo key becomes a path segment under workspace/ and a git branch component.
// Constrain it so it can never traverse (`..`, `/`) or be read as a git option.
const KEY_RE = /^[a-z0-9][a-z0-9._-]*$/;

export function validateCatalog(obj) {
  const problems = [];
  if (!obj || typeof obj !== 'object' || !obj.repos || typeof obj.repos !== 'object') {
    return ['top-level `repos:` map is missing'];
  }
  const keys = Object.keys(obj.repos);
  for (const key of keys) {
    if (!KEY_RE.test(key)) {
      problems.push(`repos.${key}: key must match ${KEY_RE} (lowercase alphanumeric, dots, dashes, underscores)`);
    }
    const e = obj.repos[key] || {};
    for (const f of REQUIRED) {
      if (e[f] === undefined || e[f] === null || e[f] === '') {
        problems.push(`repos.${key}: missing required field \`${f}\``);
      }
    }
    if (e.url && !URL_RE.test(String(e.url))) {
      problems.push(`repos.${key}: \`url\` must start with https:// or git@ (got "${e.url}")`);
    }
    if (e.responsibilities !== undefined) {
      if (!Array.isArray(e.responsibilities) || e.responsibilities.length === 0) {
        problems.push(`repos.${key}: \`responsibilities\` must be a non-empty list`);
      }
    }
    for (const dep of e.depends_on ?? []) {
      if (!keys.includes(dep)) {
        problems.push(`repos.${key}: \`depends_on\` references unknown repo "${dep}"`);
      }
    }
  }
  return problems;
}

function normalise(obj) {
  const repos = {};
  for (const [key, e] of Object.entries(obj.repos)) {
    repos[key] = {
      url: e.url,
      default_branch: e.default_branch,
      domain: e.domain,
      summary: String(e.summary).trim(),
      responsibilities: e.responsibilities,
      depends_on: e.depends_on ?? [],
      keywords: e.keywords ?? [],
      notes: e.notes ?? false,
    };
  }
  return { repos };
}

export function loadCatalog(rootDir) {
  const path = join(rootDir, 'repos.yml');
  if (!existsSync(path)) {
    throw new CatalogError(`repos.yml not found at ${path}. Run /setup-sdlc to create it.`);
  }
  let parsed;
  try {
    parsed = parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new CatalogError(`repos.yml is not valid YAML: ${err.message}`);
  }
  const problems = validateCatalog(parsed);
  if (problems.length) {
    throw new CatalogError(`repos.yml has ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);
  }
  return normalise(parsed);
}
