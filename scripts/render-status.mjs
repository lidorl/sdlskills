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
import { isEntryPoint } from './lib/is-entry-point.mjs';
import { boardEnabled, loadConfig } from './lib/board/config.mjs';
import { boardView } from './lib/board/registry.mjs';
import { parseLog } from './lib/board/events.mjs';

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

function readDir(root, sub) {
  const dir = join(root, 'docs', sub);
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

function countBoxes(root, relPath) {
  const p = join(root, relPath);
  if (!existsSync(p)) return null;
  const t = readFileSync(p, 'utf8');
  const done = (t.match(/^\s*[-*]\s+\[x\]/gim) || []).length;
  const open = (t.match(/^\s*[-*]\s+\[ \]/gim) || []).length;
  return { done, open, total: done + open };
}

/** Split a markdown table row into trimmed cells, tolerating a missing leading/trailing pipe. */
function tableCells(row) {
  const cells = row.split('|').map((c) => c.trim());
  if (cells[0] === '') cells.shift();
  if (cells.length && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

/**
 * Parse a plan's `## Pull Requests` markdown table.
 * Returns { merged, total } over the data rows, or null if there is no table.
 * Fences are tracked line-by-line so example tables inside ``` / ~~~ blocks
 * (the kit's plans are full of them) never count.
 */
export function parsePullRequests(text) {
  const lines = text.split(/\r?\n/);
  let inFence = false;
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*(```|~~~)/.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && /^##\s+Pull Requests\s*$/.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  const section = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence;
    if (inFence) continue;
    if (/^#{1,6}\s/.test(lines[i])) break;
    section.push(lines[i]);
  }
  const rows = section
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|') && !/^\|?[\s:|-]+\|?$/.test(l));
  const data = rows.slice(1); // drop the header row
  if (!data.length) return null;

  let merged = 0;
  for (const row of data) {
    const cells = tableCells(row);
    if ((cells[cells.length - 1] || '').toLowerCase() === 'merged') merged += 1;
  }
  return { merged, total: data.length };
}

const LIFECYCLE = ['ACCEPTED', 'DESIGNED', 'PLANNED', 'IN_PROGRESS', 'IMPLEMENTED'];
const PARKED = ['PARKED', 'REJECTED'];
const DEFAULT_LEASE_MS = 4 * 3600e3;

/** Human-readable duration: `<1m`, `5m`, `2h 5m`, `2h`, `3d`. */
export function humanAge(ms) {
  const mins = Math.floor(Math.max(0, ms) / 60e3);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return mins % 60 ? `${h}h ${mins % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const ms = (v) => { const t = new Date(v).getTime(); return Number.isNaN(t) ? null : t; };

/** Board data for STATUS.md. The log is read from the working tree's HEAD; any failure means no events. */
function loadBoard(root, now, events) {
  let ttlMs = DEFAULT_LEASE_MS;
  try { ttlMs = loadConfig(root).leaseTtlMs; } catch { /* a broken config must not break the status view */ }
  let evs = events;
  if (!evs) {
    try { evs = parseLog(root, { ref: 'HEAD' }); } catch { evs = []; }
  }
  return boardView(root, { now, ttlMs, events: evs });
}

function workersSection(view, now) {
  if (!view.workers.length) return '_none_\n';
  const byOwner = new Map();
  for (const w of view.workers) (byOwner.get(w.owner || '(unknown)') ?? byOwner.set(w.owner || '(unknown)', []).get(w.owner || '(unknown)')).push(w);
  const head = '| Worker | Name | Host | Agent / model | State | Effort | Last seen |\n|---|---|---|---|---|---|---|\n';
  const groups = [...byOwner.keys()].sort().map((owner) => {
    const rows = byOwner.get(owner).sort((a, b) => a.id.localeCompare(b.id)).map((w) => {
      const seen = w.lastSeen ? `${humanAge(now - new Date(w.lastSeen))} ago` : '-';
      return `| ${cell(w.id)} | ${cell(w.name)} | ${cell(w.host)} | ${cell(w.agent)} / ${cell(w.model)} | ${w.state} | ${cell(w.effort ?? '-')} | ${seen} |`;
    });
    return `### ${owner}\n${head}${rows.join('\n')}\n`;
  });
  return `${groups.join('\n')}\n_State is derived from the last 2000 board commits._\n`;
}

function inboxSection(view, now) {
  const keys = Object.keys(view.inbox).filter((k) => view.inbox[k].length);
  if (!keys.length) return '_none_\n';
  keys.sort((a, b) => (a === 'approvers') - (b === 'approvers') || a.localeCompare(b));
  const head = '| Request | Kind | Effort | Age |\n|---|---|---|---|\n';
  return keys.map((k) => {
    const rows = view.inbox[k].map((r) => {
      const t = ms(r.fm.created_at);
      return `| ${cell(r.id)} | ${cell(r.fm.kind)} | ${cell(r.fm.effort ?? '-')} | ${t === null ? '-' : humanAge(now - t)} |`;
    });
    return `### ${k === 'undefined' || k === '' ? '(unknown)' : k}\n${head}${rows.join('\n')}\n`;
  }).join('\n');
}

/** Pure: reads `root`, returns the rendered STATUS.md text and the .status.json object. */
export function renderStatus({ root, now = new Date(), events } = {}) {
  const featReqs = readDir(root, 'feat-req');
  const designs = readDir(root, 'design').filter(
    (d) => d.name !== 'architecture' && d.name !== 'data-model' && !d.name.startsWith('STYLE_GUIDE')
  );
  const plans = readDir(root, 'plans');
  const designByName = Object.fromEntries(designs.map((d) => [d.name, d]));

  /** Plans belonging to a feature: `<name>.md` or the split form `<name>-1.md`, `<name>-2.md`, … */
  const plansFor = (name) => {
    const split = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+$`);
    return plans
      .filter((p) => p.name === name || split.test(p.name))
      .sort((a, b) => a.name.localeCompare(b.name));
  };

  const rows = featReqs.map((fr) => {
    const featPlans = plansFor(fr.name);
    let done = 0;
    let total = 0;
    let merged = 0;
    let prTotal = 0;
    for (const p of featPlans) {
      const boxes = countBoxes(root, p.file);
      if (boxes) {
        done += boxes.done;
        total += boxes.total;
      }
      const pr = parsePullRequests(readFileSync(join(root, p.file), 'utf8'));
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

  const board = boardEnabled(root) ? loadBoard(root, now, events) : null;
  const claims = new Map((board?.inFlight ?? []).map((c) => [c.slug, c]));

  const stamp = now.toISOString().replace('T', ' ').slice(0, 16);
  const active = rows.filter((r) => LIFECYCLE.includes(r.status) && r.status !== 'IMPLEMENTED');
  const parked = rows.filter((r) => PARKED.includes(r.status));
  const implemented = rows.filter((r) => r.status === 'IMPLEMENTED');

  const table = (list, withClaims = false) => {
    if (!list.length) return '_none_\n';
    const head =
      '| Feature | Status | Pri | Sev | Plan | PRs | Age |' +
      (withClaims ? ' Claimant | Claim age | Stale |' : '') +
      '\n|---|---|---|---|---|---|---|' +
      (withClaims ? '---|---|---|' : '') +
      '\n';
    return (
      head +
      list
        .map((r) => {
          const c = claims.get(r.name);
          const claim = withClaims
            ? ` ${c ? `${cell(c.claimant)} | ${humanAge(c.claimAgeMs)} | ${c.stale ? 'yes' : ''}` : '- | - | '} |`
            : '';
          return `| [${r.title}](${r.feat_req}) | ${r.status} | ${r.priority} | ${r.severity} | ${
            r.plan_progress || '-'
          } | ${r.pr_progress || '-'} | ${r.date} |${claim}`;
        })
        .join('\n') +
      '\n'
    );
  };
  const byStatus = (s) => active.filter((r) => r.status === s);
  const boardSections = board
    ? `## Workers\n${workersSection(board, now)}\n## Inbox\n${inboxSection(board, now)}\n`
    : '';

  const md = `# Project Status

_Generated by \`scripts/render-status.mjs\` at ${stamp}. Do not edit by hand._

${boardSections}## Active

### In Progress
${table(byStatus('IN_PROGRESS'), !!board)}
### Planned
${table(byStatus('PLANNED'), !!board)}
### Designed (ready to plan)
${table(byStatus('DESIGNED'), !!board)}
### Accepted (queue)
${table(byStatus('ACCEPTED'), !!board)}

## Parked / Rejected
${table(parked)}

## Implemented
${table(implemented)}

---
_${featReqs.length} feature requests · ${designs.length} design docs · ${plans.length} plans_
`;

  const json = { generated: stamp, features: rows };
  if (board) {
    json.workers = board.workers.map((w) => ({
      id: w.id, owner: w.owner, name: w.name, host: w.host, agent: w.agent, model: w.model,
      state: w.state, effort: w.effort ?? null, last_seen: w.lastSeen ? new Date(w.lastSeen).toISOString() : null,
    }));
    json.requests = Object.values(board.inbox).flat().map((r) => ({
      id: r.id, kind: r.fm.kind ?? null, for: r.fm.for ?? null, effort: r.fm.effort ?? null,
      created_at: ms(r.fm.created_at) === null ? null : new Date(r.fm.created_at).toISOString(),
    }));
  }
  return { md, json, counts: { active: active.length, parked: parked.length, implemented: implemented.length } };
}

if (isEntryPoint(import.meta.url)) {
  const rootArg = process.argv.indexOf('--root');
  const root = rootArg !== -1 ? process.argv[rootArg + 1] : process.cwd();
  const { md, json, counts } = renderStatus({ root, now: new Date() });
  writeFileSync(join(root, 'docs', 'STATUS.md'), md);
  writeFileSync(join(root, 'docs', '.status.json'), JSON.stringify(json, null, 2));
  console.log(
    `render-status: ${counts.active} active, ${counts.parked} parked, ${counts.implemented} implemented → docs/STATUS.md`
  );
}
