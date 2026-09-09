#!/usr/bin/env node
/**
 * render-status.mjs — derives docs/STATUS.md (and docs/.status.json) from the
 * frontmatter of every feature request, design doc, and plan.
 *
 * Pure read → render. Never takes a status as input, never holds authoritative
 * state. Safe to run any time; idempotent. Wired to a Stop hook.
 *
 * Usage: node scripts/render-status.mjs [--root <dir>]
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const rootArg = process.argv.indexOf('--root');
const ROOT = rootArg !== -1 ? process.argv[rootArg + 1] : process.cwd();
const DOCS = join(ROOT, 'docs');

/** Minimal YAML-frontmatter parser: flat `key: value` pairs only. */
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function readDir(sub) {
  const dir = join(DOCS, sub);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const path = join(dir, f);
      const text = readFileSync(path, 'utf8');
      const fm = parseFrontmatter(text);
      const title = (text.match(/^#\s+(.+)$/m) || [])[1] || basename(f, '.md');
      return { file: `docs/${sub}/${f}`, name: basename(f, '.md'), title, ...fm };
    });
}

function countBoxes(relPath) {
  const p = join(ROOT, relPath);
  if (!existsSync(p)) return null;
  const t = readFileSync(p, 'utf8');
  const done = (t.match(/^\s*[-*]\s+\[x\]/gim) || []).length;
  const open = (t.match(/^\s*[-*]\s+\[ \]/gim) || []).length;
  return { done, open, total: done + open };
}

/**
 * Parse a plan's `## Pull Requests` markdown table.
 * Returns { merged, total } over the data rows, or null if there is no table.
 * Fenced code blocks are stripped first so example tables inside task
 * descriptions don't count.
 */
export function parsePullRequests(text) {
  const noFences = text.replace(/^```[\s\S]*?^```/gm, '');
  const lines = noFences.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Pull Requests\s*$/.test(l));
  if (start === -1) return null;
  const section = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{1,6}\s/.test(lines[i])) break;
    section.push(lines[i]);
  }
  const rows = section
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|') && !/^\|[\s:|-]+\|?$/.test(l));
  const data = rows.slice(1); // drop the header row
  if (!data.length) return null;
  let merged = 0;
  for (const row of data) {
    const cells = row
      .split('|')
      .map((c) => c.trim())
      .filter((_, i, a) => i > 0 && i < a.length - 1);
    if ((cells[cells.length - 1] || '').toLowerCase() === 'merged') merged += 1;
  }
  return { merged, total: data.length };
}

const featReqs = readDir('feat-req');
const designs = readDir('design').filter(
  (d) => d.name !== 'architecture' && d.name !== 'data-model' && !d.name.startsWith('STYLE_GUIDE')
);
const plans = readDir('plans');

const designByName = Object.fromEntries(designs.map((d) => [d.name, d]));
const planByName = Object.fromEntries(plans.map((p) => [p.name, p]));

const LIFECYCLE = ['ACCEPTED', 'DESIGNED', 'PLANNED', 'IN_PROGRESS', 'IMPLEMENTED'];
const PARKED = ['PARKED', 'REJECTED'];

const rows = featReqs.map((fr) => {
  // A feature may have one plan (`<name>.md`) or several (`<name>-1.md`, …).
  const featPlans = plans
    .filter((p) => p.name === fr.name || p.name.startsWith(`${fr.name}-`))
    .sort((a, b) => a.name.localeCompare(b.name));
  let done = 0;
  let total = 0;
  let merged = 0;
  let prTotal = 0;
  for (const p of featPlans) {
    const boxes = countBoxes(p.file);
    if (boxes) {
      done += boxes.done;
      total += boxes.total;
    }
    const pr = parsePullRequests(readFileSync(join(ROOT, p.file), 'utf8'));
    if (pr) {
      merged += pr.merged;
      prTotal += pr.total;
    }
  }
  return {
    name: fr.name,
    title: fr.title,
    status: fr.status || 'UNKNOWN',
    priority: fr.priority || '-',
    severity: fr.severity || '-',
    date: fr.date || '-',
    feat_req: fr.file,
    design: designByName[fr.name]?.file || null,
    plan: featPlans.map((p) => p.file),
    plan_progress: total ? `${done}/${total}` : null,
    pr_progress: prTotal ? `${merged}/${prTotal} merged` : null,
  };
});

// ---- render markdown ----
const now = new Date().toISOString().replace('T', ' ').slice(0, 16);
const active = rows.filter((r) => LIFECYCLE.includes(r.status) && r.status !== 'IMPLEMENTED');
const parked = rows.filter((r) => PARKED.includes(r.status));
const done = rows.filter((r) => r.status === 'IMPLEMENTED');

function table(list) {
  if (!list.length) return '_none_\n';
  const head =
    '| Feature | Status | Pri | Sev | Plan | PRs | Age |\n|---|---|---|---|---|---|---|\n';
  return (
    head +
    list
      .map(
        (r) =>
          `| [${r.title}](${r.feat_req}) | ${r.status} | ${r.priority} | ${r.severity} | ${
            r.plan_progress || '-'
          } | ${r.pr_progress || '-'} | ${r.date} |`
      )
      .join('\n') +
    '\n'
  );
}

const byStatus = (s) => active.filter((r) => r.status === s);

const md = `# Project Status

_Generated by \`scripts/render-status.mjs\` at ${now}. Do not edit by hand._

## Active

### In Progress
${table(byStatus('IN_PROGRESS'))}
### Planned
${table(byStatus('PLANNED'))}
### Designed (ready to plan)
${table(byStatus('DESIGNED'))}
### Accepted (queue)
${table(byStatus('ACCEPTED'))}

## Parked / Rejected
${table(parked)}

## Implemented
${table(done)}

---
_${featReqs.length} feature requests · ${designs.length} design docs · ${plans.length} plans_
`;

writeFileSync(join(DOCS, 'STATUS.md'), md);
writeFileSync(
  join(DOCS, '.status.json'),
  JSON.stringify({ generated: now, features: rows }, null, 2)
);

console.log(
  `render-status: ${active.length} active, ${parked.length} parked, ${done.length} implemented → docs/STATUS.md`
);
