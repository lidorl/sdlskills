// Which files belong to an effort: the set a report commits (`sdlc report` and the worker's report).
import { existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, posix } from 'node:path';
import { safePath } from './safe-path.mjs';

const gitOut = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// Which docs belong to an effort: exact names only, so `bulk` never takes `bulk-export` files.
function ownerPatterns(slug) {
  return [
    new RegExp(`^docs/feat-req/${slug}\\.md$`),
    new RegExp(`^docs/design/${slug}\\.md$`),
    new RegExp(`^docs/plans/${slug}(-\\d+)?\\.md$`),
  ];
}
// Is `rel` one of the effort's own plan files (docs/plans/<slug>.md or <slug>-<n>.md)?
export const isPlanPath = (slug, rel) => ownerPatterns(slug)[2].test(rel);
// Shared docs a design run may write beside the effort's own: ADRs (new or changed) and the two design companions.
const ADR_RE = /^docs\/decisions\/[^/]+\.md$/;
const COMPANION_RE = /^docs\/design\/(architecture|data-model)\.md$/;
const historyRe = (slug) => new RegExp(`^docs/history/[^/]*_${slug}(-\\d+)?\\.md$`);

// The files a report commits for an effort: its docs, history entries, ADRs and design companion docs changed
// since origin/main, and extras.
export function reportPaths(root, slug, extra = []) {
  const out = [];
  const add = (rel) => { if (!out.includes(rel) && existsSync(safePath(root, rel))) out.push(rel); };
  const [featRe, designRe, planRe] = ownerPatterns(slug);
  add(`docs/feat-req/${slug}.md`);
  add(`docs/design/${slug}.md`);
  const plans = join(root, 'docs/plans');
  if (existsSync(plans)) {
    for (const n of readdirSync(plans).sort()) if (planRe.test(`docs/plans/${n}`)) add(`docs/plans/${n}`);
  }
  const changed = new Set([
    ...gitOut(root, ['ls-files', '--others', '--exclude-standard', '--', 'docs/history']).split('\n'),
    ...gitOut(root, ['diff', '--name-only', 'origin/main', '--', 'docs/history']).split('\n'),
  ].filter(Boolean));
  const hist = historyRe(slug);
  for (const rel of [...changed].sort()) if (hist.test(rel)) add(rel);
  const shared = new Set([
    ...gitOut(root, ['ls-files', '--others', '--exclude-standard', '--', 'docs/decisions']).split('\n'),
    ...gitOut(root, ['diff', '--name-only', 'origin/main', '--', 'docs/decisions', 'docs/design/architecture.md', 'docs/design/data-model.md']).split('\n'),
  ].filter(Boolean));
  for (const rel of [...shared].sort()) if (ADR_RE.test(rel) || COMPANION_RE.test(rel)) add(rel);
  for (const p of extra) {
    safePath(root, p);
    const rel = posix.normalize(p.replaceAll('\\', '/'));
    if (rel === 'board' || rel.startsWith('board/')) throw new Error(`--paths: ${p} is under board/; reports never write there`);
    if (/^docs\/(feat-req|design|plans)\//.test(rel) && ![featRe, designRe, planRe, COMPANION_RE].some((re) => re.test(rel))) {
      throw new Error(`--paths: ${p} does not belong to ${slug}`);
    }
    if (!existsSync(join(root, rel))) throw new Error(`--paths: ${p} does not exist`);
    add(rel);
  }
  return out;
}
