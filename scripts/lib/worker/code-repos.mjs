// The effort's code-repo checkouts under meta/workspace/: pushed before every report and release, so a
// takeover's assemble-env finds origin/feat/<slug>. Never forced.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const firstLine = (e) => String(e?.stderr || e?.message || e).trim().split('\n').pop();

// For each key checked out on feat/<slug> (readonly checkouts are detached and skipped): push the branch,
// and note uncommitted changes, which are never pushed. -> { pushed, dirty, failed: [{ key, error }] }
export function pushCodeBranches(clone, slug, keys) {
  const branch = `feat/${slug}`;
  const out = { pushed: [], dirty: [], failed: [] };
  for (const key of keys) {
    const dir = join(clone, 'workspace', key);
    if (!existsSync(join(dir, '.git'))) continue;
    try {
      if (git(dir, ['symbolic-ref', '-q', '--short', 'HEAD']).trim() !== branch) continue;
    } catch { continue; }
    if (git(dir, ['status', '--porcelain']).trim()) out.dirty.push(key);
    try {
      git(dir, ['push', '-q', '-u', 'origin', `refs/heads/${branch}:refs/heads/${branch}`]);
      out.pushed.push(key);
    } catch (e) {
      out.failed.push({ key, error: firstLine(e) });
    }
  }
  return out;
}

export const dirtyNote = (dirty) => dirty.map((k) => `workspace/${k} has uncommitted changes (not pushed)`).join('\n');
