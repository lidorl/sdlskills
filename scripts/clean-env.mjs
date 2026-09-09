#!/usr/bin/env node
/**
 * clean-env.mjs — remove workspace/ checkouts. See execution-environment.md → "Scripts".
 */
import { existsSync, readdirSync, rmSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

function isProtected(dir) {
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
    return false; // not a git repo → nothing to protect
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
