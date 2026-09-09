#!/usr/bin/env node
/**
 * clean-env.mjs — remove workspace/ checkouts. See execution-environment.md → "Scripts".
 */
import { existsSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * A checkout is "protected" (skip without --force) if it has uncommitted or
 * unpushed work. Fail safe: if `.git` is present but git commands error (lock
 * file, git missing, transient failure), treat it as protected — never delete
 * on uncertainty. Only a directory with no `.git` at all is unprotected
 * (assemble-env only ever creates clones there).
 */
function isProtected(dir) {
  if (!existsSync(join(dir, '.git'))) return false;
  try {
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir, stdio: 'pipe' }).toString().trim();
    if (status) return true;
    const unpushed = execFileSync('git', ['log', '--branches', '--not', '--remotes', '--oneline'], {
      cwd: dir,
      stdio: 'pipe',
    })
      .toString()
      .trim();
    return Boolean(unpushed);
  } catch {
    return true; // .git present but git failed — do not delete on uncertainty
  }
}

export function clean({ rootDir, keys = [], force = false }) {
  const wsDir = join(rootDir, 'workspace');
  if (!existsSync(wsDir)) return { removed: [], skipped: [] };
  const present = readdirSync(wsDir).filter((d) => !d.startsWith('.'));
  const targets = keys.length ? keys.filter((k) => present.includes(k)) : present;

  const removed = [];
  const skipped = [];
  for (const key of targets) {
    const dir = join(wsDir, key);
    if (!force && isProtected(dir)) {
      skipped.push(key);
      continue;
    }
    rmSync(dir, { recursive: true, force: true });
    removed.push(key);
  }

  const left = readdirSync(wsDir).filter((d) => !d.startsWith('.'));
  const marker = join(wsDir, '.current-effort');
  if (!left.length && existsSync(marker)) unlinkSync(marker);

  return { removed, skipped };
}

function main() {
  const args = process.argv.slice(2);
  const rootIx = args.indexOf('--root');
  const rootDir = rootIx !== -1 ? args[rootIx + 1] : process.cwd();
  const force = args.includes('--force');
  const keys = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--root');
  const r = clean({ rootDir, keys, force });
  const skippedNote = r.skipped.length
    ? ` — skipped (uncommitted work, use --force) [${r.skipped.join(', ')}]`
    : '';
  console.log(`clean-env: removed [${r.removed.join(', ')}]${skippedNote}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
