// Queue ranking: the code version of select-next-task Step 3 rules 2-5 (rule 1, user override, stays in
// the skill). Pure functions over a docs tree; no git calls. Problem files are repo-relative.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { parseDoc } from './frontmatter.mjs';
import { claimState } from './claims.mjs';
import { safePath, SLUG_RE } from './safe-path.mjs';

const CANDIDATE = new Set(['ACCEPTED', 'DESIGNED', 'PLANNED', 'IN_PROGRESS']);
const IN_FLIGHT = new Set(['DESIGNED', 'PLANNED', 'IN_PROGRESS']);
const PRIORITY = { high: 0, medium: 1, low: 2 };

// yaml may hand back a string or a Date; compare as ISO date strings, '' = missing = oldest.
const normDate = (d) => {
  if (d instanceof Date) return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  return d == null ? '' : String(d);
};

export function loadEfforts(root) {
  const efforts = [];
  const problems = [];
  const read = (rel) => readFileSync(safePath(root, rel), 'utf8'); // the path guard throws on a symlink
  let dir;
  try { dir = safePath(root, 'docs/feat-req'); } catch (err) { return { efforts, problems: [{ file: 'docs/feat-req', message: err.message }] }; }
  if (!existsSync(dir)) return { efforts, problems };
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const slug = name.slice(0, -3);
    const file = `docs/feat-req/${name}`;
    if (!SLUG_RE.test(slug)) { problems.push({ file, message: `"${slug}" is not a valid slug (lowercase letters, digits, dashes)` }); continue; }
    let fm;
    try {
      fm = parseDoc(read(file)).data ?? {};
    } catch (err) {
      problems.push({ file, message: err.message });
      continue;
    }
    let repos = [];
    const designFile = `docs/design/${name}`;
    try {
      if (existsSync(safePath(root, designFile))) {
        const r = parseDoc(read(designFile)).data?.repos;
        if (Array.isArray(r)) repos = r.map(String);
      }
    } catch (err) {
      problems.push({ file: designFile, message: err.message });
    }
    efforts.push({
      slug, status: fm.status, priority: fm.priority, severity: fm.severity, date: normDate(fm.date), fm, repos,
      security: fm.security === true || (Array.isArray(fm.tags) && fm.tags.includes('security')),
    });
  }
  return { efforts, problems };
}

const priorityRank = (p) => PRIORITY[String(p ?? '').toLowerCase()] ?? 3;
const urgent = (e) => e.security || String(e.severity ?? '').toLowerCase() === 'critical';

export function rank(efforts, { now, ttlMs, openRequestIds }) {
  return efforts
    .filter((e) => CANDIDATE.has(e.status)
      && claimState(e.fm, now, ttlMs) !== 'live'
      && !(e.fm?.awaiting && openRequestIds.has(e.fm.awaiting)))
    .sort((a, b) =>
      (urgent(b) - urgent(a))
      || (IN_FLIGHT.has(b.status) - IN_FLIGHT.has(a.status))
      || (priorityRank(a.priority) - priorityRank(b.priority))
      || normDate(a.date).localeCompare(normDate(b.date))
      || a.slug.localeCompare(b.slug));
}

export function overlaps(effort, efforts, { now, ttlMs, readonlyKeys }) {
  const mine = new Set(effort.repos.filter((r) => !readonlyKeys.has(r)));
  const out = [];
  for (const o of efforts) {
    if (o.slug === effort.slug || claimState(o.fm, now, ttlMs) !== 'live') continue;
    const shared = o.repos.filter((r) => mine.has(r));
    if (shared.length) out.push({ slug: o.slug, repos: shared });
  }
  return out;
}
