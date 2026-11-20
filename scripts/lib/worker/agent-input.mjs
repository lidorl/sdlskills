// Agent input from applied answers, persisted per effort until an agent run has acted on it (Ruling P2-3).
// It survives a crash, a failed run and a lost claim, so a person's decision reaches the next run.
import { readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SLUG_RE } from '../board/safe-path.mjs';

const dir = (home) => join(home, 'run', 'agent-input');
const file = (home, slug) => join(dir(home), `${slug}.json`);

export function readInput(home, slug) {
  try {
    const j = JSON.parse(readFileSync(file(home, slug), 'utf8'));
    return Array.isArray(j?.agentInput) ? j.agentInput.map(String) : [];
  } catch { return []; }
}

export function writeInput(home, slug, agentInput) {
  mkdirSync(dir(home), { recursive: true });
  writeFileSync(file(home, slug), `${JSON.stringify({ slug, agentInput }, null, 2)}\n`);
}

export const clearInput = (home, slug) => rmSync(file(home, slug), { force: true });

// Efforts with saved input, oldest-named first.
export function savedSlugs(home) {
  if (!existsSync(dir(home))) return [];
  return readdirSync(dir(home)).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter((s) => SLUG_RE.test(s)).sort();
}
