// The effort's code-repo checkouts under meta/workspace/: pushed before every report and release, so a
// takeover's assemble-env finds origin/feat/<slug>. Never forced.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const firstLine = (e) => String(e?.stderr || e?.message || e).trim().split('\n').pop();

// For each key checked out on feat/<slug> (readonly checkouts are detached and skipped): push the branch,
// and note uncommitted changes, which are never pushed. `advanced` lists the keys whose remote branch moved.
// -> { pushed, advanced, dirty, failed: [{ key, error }] }
export function pushCodeBranches(clone, slug, keys) {
  const branch = `feat/${slug}`;
  const out = { pushed: [], advanced: [], dirty: [], failed: [] };
  for (const key of keys) {
    const dir = join(clone, 'workspace', key);
    if (!existsSync(join(dir, '.git'))) continue;
    try {
      if (git(dir, ['symbolic-ref', '-q', '--short', 'HEAD']).trim() !== branch) continue;
    } catch { continue; }
    if (git(dir, ['status', '--porcelain']).trim()) out.dirty.push(key);
    try {
      const before = git(dir, ['ls-remote', 'origin', `refs/heads/${branch}`]).split('\t')[0].trim();
      git(dir, ['push', '-q', '-u', 'origin', `refs/heads/${branch}:refs/heads/${branch}`]);
      out.pushed.push(key);
      if (before !== git(dir, ['rev-parse', 'HEAD']).trim()) out.advanced.push(key);
    } catch (e) {
      out.failed.push({ key, error: firstLine(e) });
    }
  }
  return out;
}

// On a fresh hold (Rulings P2-11, P2-13): an existing checkout's feat/<slug> must start from what was last
// pushed, not from a branch this worker left behind. Only when the hold continues our own live claim
// (`continued`) are local commits ours to keep: a local branch ahead of origin's (or the only branch, when
// origin has none) stays. Otherwise a local branch that differs from origin's is kept aside as
// salvaged/feat/<slug>-<stamp> and the checkout restarts from origin/feat/<slug>, or, when origin has none,
// from the default branch (assemble-env's case 3). Checkouts must be clean (salvaged) first. Returns log lines.
export function prepareCheckouts(clone, slug, keys, stamp, { continued = false } = {}) {
  const branch = `feat/${slug}`;
  const notes = [];
  const rev = (dir, ref) => { try { return git(dir, ['rev-parse', '--verify', '-q', ref]).trim(); } catch { return null; } };
  for (const key of keys) {
    const dir = join(clone, 'workspace', key);
    if (!existsSync(join(dir, '.git'))) continue;
    const local = rev(dir, `refs/heads/${branch}`);
    const aside = `salvaged/${branch}-${stamp}`;
    if (git(dir, ['ls-remote', '--heads', 'origin', branch]).trim()) {
      git(dir, ['fetch', '-q', 'origin', branch]);
      const remote = rev(dir, 'FETCH_HEAD');
      if (local === remote) continue;
      if (local && continued) {
        try {
          git(dir, ['merge-base', '--is-ancestor', remote, local]);
          notes.push(`workspace/${key}: kept our unpushed ${branch} commits (continuing our claim)`);
          continue;
        } catch { /* diverged: set aside below */ }
      }
      if (local) {
        git(dir, ['branch', '-f', aside, local]);
        notes.push(`workspace/${key}: local ${branch} set aside as ${aside}`);
      }
      git(dir, ['checkout', '-q', '-B', branch, remote]);
      notes.push(`workspace/${key}: ${branch} reset to origin/${branch}`);
    } else if (local && !continued) {
      git(dir, ['branch', '-m', branch, aside]);
      notes.push(`workspace/${key}: unpushed local ${branch} renamed to ${aside}`);
    }
  }
  return notes;
}

export const dirtyNote = (dirty) => dirty.map((k) => `workspace/${k} has uncommitted changes (not pushed)`).join('\n');
