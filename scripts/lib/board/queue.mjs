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

// `after: [slug, ...]` orders efforts: blocked until every listed slug is exactly IMPLEMENTED.
export function afterList(fm) {
  const a = fm?.after;
  if (a == null) return [];
  return (Array.isArray(a) ? a : [a]).map(String);
}

// The `after` entries not yet IMPLEMENTED. Invalid and unknown slugs (statusOf -> null) count as unmet.
export function unmetAfter(fm, statusOf) {
  return afterList(fm).filter((s) => !SLUG_RE.test(s) || statusOf(s) !== 'IMPLEMENTED');
}

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
  checkAfter(efforts, problems);
  return { efforts, problems };
}

function checkAfter(efforts, problems) {
  const known = new Set(efforts.map((x) => x.slug));
  for (const x of efforts) {
    for (const s of afterList(x.fm)) {
      const file = `docs/feat-req/${x.slug}.md`;
      if (!SLUG_RE.test(s)) problems.push({ file, message: `after: "${s}" is not a valid slug (lowercase letters, digits, dashes)` });
      else if (!known.has(s)) problems.push({ file, message: `after: "${s}" is not a feature request` });
    }
  }
  // DFS over valid edges; each cycle is reported once, from the first slug (sorted order) that reaches it.
  const edges = new Map(efforts.map((x) => [x.slug, afterList(x.fm).filter((s) => known.has(s))]));
  const done = new Set();
  const stack = [];
  const visit = (slug) => {
    const at = stack.indexOf(slug);
    if (at >= 0) {
      const cycle = stack.slice(at);
      problems.push({ file: `docs/feat-req/${cycle[0]}.md`, message: `after cycle: ${[...cycle, slug].join(' -> ')}` });
      return;
    }
    if (done.has(slug)) return;
    stack.push(slug);
    for (const next of edges.get(slug)) visit(next);
    stack.pop();
    done.add(slug);
  };
  for (const x of efforts) visit(x.slug);
}

const priorityRank = (p) => PRIORITY[String(p ?? '').toLowerCase()] ?? 3;
const urgent = (e) => e.security || String(e.severity ?? '').toLowerCase() === 'critical';

export function rank(efforts, { now, ttlMs, openRequestIds }) {
  const statusOf = new Map(efforts.map((e) => [e.slug, e.status]));
  return efforts
    .filter((e) => CANDIDATE.has(e.status)
      && unmetAfter(e.fm, (s) => statusOf.get(s) ?? null).length === 0
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
