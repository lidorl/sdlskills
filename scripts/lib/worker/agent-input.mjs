// Agent input from applied answers, persisted per effort until an agent run has acted on it (Ruling P2-3).
// It is tied to the hold that applied it: `claimed_at` of that claim, `after` the effort error it waits on
// (its answer re-claims the effort), and `phase`, the routed phase (develop|close-out) the answers belong to.
// It survives a crash and a failed run; a lost claim drops it (loop.mjs decides what a new hold may fold in).
import { readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SLUG_RE } from '../board/safe-path.mjs';

const dir = (home) => join(home, 'run', 'agent-input');
const file = (home, slug) => join(dir(home), `${slug}.json`);

// -> { agentInput: [string], claimed_at, after, phase } (empty agentInput when nothing is saved)
export function readSaved(home, slug) {
  try {
    const j = JSON.parse(readFileSync(file(home, slug), 'utf8'));
    return {
      agentInput: Array.isArray(j?.agentInput) ? j.agentInput.map(String) : [],
      claimed_at: j?.claimed_at ?? null, after: j?.after ?? null, phase: j?.phase ?? null,
    };
  } catch { return { agentInput: [], claimed_at: null, after: null, phase: null }; }
}

export const readInput = (home, slug) => readSaved(home, slug).agentInput;

export function writeInput(home, slug, agentInput, { claimed_at = null, after = null, phase = null } = {}) {
  mkdirSync(dir(home), { recursive: true });
  writeFileSync(file(home, slug), `${JSON.stringify({ slug, agentInput, claimed_at, after, phase }, null, 2)}\n`);
}

export const clearInput = (home, slug) => rmSync(file(home, slug), { force: true });

// Efforts with saved input, oldest-named first.
export function savedSlugs(home) {
  if (!existsSync(dir(home))) return [];
  return readdirSync(dir(home)).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter((s) => SLUG_RE.test(s)).sort();
}
