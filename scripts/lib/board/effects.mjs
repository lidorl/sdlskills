// Answer effects: what happens, in the docs, once a request has been answered. Answering only writes
// the request file; the next claimant of the effort applies it all in one `apply` commit.
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { stringify } from 'yaml';
import { boardWrite } from './git.mjs';
import { holds } from './claims.mjs';
import { parseDoc, setFields, appendToSection } from './frontmatter.mjs';
import { buildRequest, newRequestId, validateRequest, answeredFor } from './requests.mjs';

const LIFECYCLE = ['ACCEPTED', 'DESIGNED', 'PLANNED', 'IN_PROGRESS'];
const featRel = (slug) => `docs/feat-req/${slug}.md`;
const designRel = (slug) => `docs/design/${slug}.md`;
const requestRel = (id) => `board/requests/${id}.md`;

class NotHolder extends Error {}

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const firstLine = (s) => String(s ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';

function readText(root, rel) {
  return readFileSync(join(root, rel), 'utf8');
}

function writeText(root, rel, text) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

// docs/plans/<slug>.md, else the highest-numbered <slug>-N.md that isn't IMPLEMENTED.
function planFor(root, slug) {
  const dir = join(root, 'docs/plans');
  if (!existsSync(dir)) return null;
  if (existsSync(join(dir, `${slug}.md`))) return `docs/plans/${slug}.md`;
  const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const numbered = readdirSync(dir)
    .map((n) => ({ n, m: new RegExp(`^${esc}-(\\d+)\\.md$`).exec(n) }))
    .filter((x) => x.m)
    .sort((a, b) => Number(b.m[1]) - Number(a.m[1]));
  for (const { n } of numbered) {
    if (parseDoc(readFileSync(join(dir, n), 'utf8')).data.status !== 'IMPLEMENTED') return `docs/plans/${n}`;
  }
  return null;
}

const planStatus = (root, rel) => parseDoc(readText(root, rel)).data.status;

function appendReviewFixes(text, id, lines) {
  const heading = `### Review fixes (${id})`;
  const parts = text.replace(/\n*$/, '').split('\n');
  const at = parts.indexOf(heading);
  if (at === -1) return `${parts.join('\n')}\n\n${heading}\n\n${lines.join('\n')}\n`;
  let end = at + 1;
  while (end < parts.length && !/^#{1,6}\s/.test(parts[end])) end += 1;
  while (end > at + 1 && parts[end - 1].trim() === '') end -= 1;
  parts.splice(end, 0, ...lines);
  return `${parts.join('\n')}\n`;
}

function addReworkStep(text, step) {
  const lines = text.split('\n');
  let at = -1;
  lines.forEach((l, i) => { if (/^\s*- \[[xX]\]/.test(l)) at = i; });
  if (at !== -1) lines.splice(at + 1, 0, step);
  else {
    const firstOpen = lines.findIndex((l) => /^\s*- \[ \]/.test(l));
    if (firstOpen !== -1) lines.splice(firstOpen, 0, step);
    else return `${text.replace(/\n*$/, '')}\n\n${step}\n`;
  }
  return lines.join('\n');
}

function findingTitle(findings = '', fid) {
  const m = new RegExp(`^###\\s+${fid}\\b(.*)$`, 'm').exec(findings);
  return (m?.[1] ?? '').replace(/^[\s:\u2014-]+/, '').trim();
}

const stripFences = (text = '') => text.split('\n').filter((l) => !/^\s*(`{3,}|~{3,})/.test(l)).join('\n').trim();

const GATE_LABEL = { 'design-approval': 'design', 'review-findings': 'review' };

export function applyAnswer(root, request, { now, claimant, rand }) {
  const { fm, sections } = request;
  const notes = (sections.Answer ?? '').trim();
  const answer = fm.answer;
  const slug = fm.effort;
  const id = request.id ?? fm.id;
  const none = { paths: [], agentInput: null, newRequests: [] };
  if (fm.scope === 'worker') return none;

  const date = now.toISOString().slice(0, 10);
  const paths = new Set([featRel(slug)]);
  const newRequests = [];
  let agentInput = null;
  let feat = readText(root, featRel(slug));
  const status = parseDoc(feat).data.status;
  const decide = (label, ans, note = notes) => {
    const tail = note ? ` \u2014 ${oneLine(note)}` : '';
    feat = appendToSection(feat, 'Decisions', `- ${date} \u00b7 ${id} \u00b7 ${label}: ${ans}${tail} (applied by ${claimant})`);
  };
  const touch = (rel, text) => { writeText(root, rel, text); paths.add(rel); };
  const label = fm.kind === 'gate' ? (GATE_LABEL[fm.gate] ?? fm.gate) : fm.kind;

  if (fm.kind === 'gate' && fm.gate === 'design-approval') {
    decide(label, answer);
    if (answer === 'approve') {
      if (existsSync(join(root, designRel(slug)))) touch(designRel(slug), setFields(readText(root, designRel(slug)), { status: 'APPROVED' }));
      feat = setFields(feat, { status: 'DESIGNED' });
    } else {
      agentInput = notes || 'design rejected without notes';
    }
  } else if (fm.kind === 'gate' && fm.gate === 'triage') {
    decide(label, answer);
    const next = { accept: 'ACCEPTED', park: 'PARKED', reject: 'REJECTED' }[answer];
    feat = setFields(feat, { status: next });
    if (answer !== 'accept') feat = appendToSection(feat, 'Triage', `- ${date} \u00b7 ${id} \u00b7 ${next}: ${oneLine(notes) || '(no reason given)'}`);
  } else if (fm.kind === 'gate' && fm.gate === 'review-findings') {
    const fixes = [];
    for (const [fid, choice] of Object.entries(answer ?? {})) {
      if (choice === 'fix') fixes.push(`- [ ] Fix review finding ${fid}: ${findingTitle(sections.Findings, fid)} (request ${id})`);
      else decide(label, `${fid} accept`);
    }
    if (fixes.length) {
      decide(label, `fix ${Object.entries(answer).filter(([, c]) => c === 'fix').map(([f]) => f).join(', ')}`, '');
      const plan = planFor(root, slug);
      if (plan) touch(plan, appendReviewFixes(readText(root, plan), id, fixes));
      else agentInput = `No plan to add review fixes to; do these first:\n${fixes.join('\n')}`;
    }
  } else if (fm.kind === 'gate') { // policy gate
    decide(label, answer);
    if (answer === 'approve') agentInput = 'proceed with the gated step';
    else {
      const i = LIFECYCLE.indexOf(status);
      if (i > 0) feat = setFields(feat, { status: LIFECYCLE[i - 1] });
      agentInput = notes || 'rejected without notes';
    }
  } else if (fm.kind === 'question') {
    decide(label, answer);
    agentInput = answer === 'text' ? notes : `Option ${answer}${notes ? `\n${notes}` : ''}`;
  } else if (fm.kind === 'clarification') {
    decide(label, answer);
    if (answer === 'correct') {
      const plan = status === 'IMPLEMENTED' ? null : planFor(root, slug);
      if (status === 'IMPLEMENTED') {
        const fslug = `${slug}-followup-${id}`;
        const ffm = { date, priority: 'Medium', severity: 'Low', status: 'ACCEPTED', source: `Clarification ${id} on ${slug}` };
        touch(featRel(fslug), `---\n${stringify(ffm, { lineWidth: 0 })}---\n\n# Follow-up: ${slug} (clarification ${id})\n\n## Problem & Context\n\n${notes}\n`);
        newRequests.push({
          id: newRequestId(now, rand), kind: 'gate', gate: 'triage', scope: 'effort', effort: fslug, phase: null,
          worker: claimant, for: fm.for, blocking: true, now,
          sections: {
            Request: `Triage the follow-up feature request ${fslug}, filed from a clarification correction on ${slug}.`,
            Context: `Clarification ${id} on ${slug} was corrected after the effort was IMPLEMENTED:\n\n${notes}`,
          },
        });
      } else if (plan && planStatus(root, plan) !== 'IMPLEMENTED') {
        touch(plan, addReworkStep(readText(root, plan), `- [ ] Rework (clarification ${id}): ${firstLine(notes)}`));
      } else {
        agentInput = notes;
      }
    }
  } else if (fm.kind === 'error') {
    decide(label, answer);
    if (answer === 'park') {
      const err = firstLine(stripFences(sections.Error)) || '(no error message)';
      feat = setFields(feat, { status: 'PARKED' });
      feat = appendToSection(feat, 'Triage', `- ${date} \u00b7 ${id} \u00b7 PARKED after error: ${err}`);
    } else {
      agentInput = answer === 'retry' ? 'resume' : notes;
    }
  }

  writeText(root, featRel(slug), feat);
  return { paths: [...paths], agentInput, newRequests };
}

export async function applyAnswered(clone, slug, opts) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await applyOnce(clone, slug, opts);
    if (r.reason !== 'lost-race') return r;
  }
  return { ok: false, reason: 'lost-race', agentInput: [] };
}

async function applyOnce(clone, slug, { claimant, identity, workerId, now, rand, hooks }) {
  let agentInput = [];
  const r = await boardWrite(clone, {
    kind: 'apply', subject: slug, identity, onReject: 'restart', hooks,
    trailers: { ...(workerId ? { worker: workerId } : {}), effort: slug },
    mutate: (c) => {
      agentInput = [];
      if (!holds(c, slug, claimant)) throw new NotHolder(); // mutate runs before any commit
      const answered = answeredFor(c, slug).sort((a, b) => (a.id < b.id ? -1 : 1));
      if (answered.length === 0) return [];
      const paths = new Set();
      for (const req of answered) {
        const eff = applyAnswer(c, req, { now, claimant, rand });
        eff.paths.forEach((p) => paths.add(p));
        if (eff.agentInput) agentInput.push(`Request ${req.id} (${req.fm.kind}): ${eff.agentInput}`);
        for (const nr of eff.newRequests) {
          const text = buildRequest(nr);
          const bad = validateRequest(text, `${nr.id}.md`);
          if (bad.length) throw new Error(`follow-up triage gate invalid: ${bad.join('; ')}`);
          writeText(c, requestRel(nr.id), text);
          paths.add(requestRel(nr.id));
          const f = featRel(nr.effort);
          writeText(c, f, setFields(readText(c, f), { awaiting: nr.id }));
          paths.add(f);
        }
        unlinkSync(req.path);
        paths.add(requestRel(req.id));
      }
      const f = featRel(slug);
      const awaiting = parseDoc(readText(c, f)).data.awaiting;
      if (awaiting && answered.some((q) => q.id === awaiting)) {
        writeText(c, f, setFields(readText(c, f), { awaiting: null }));
        paths.add(f);
      }
      return [...paths];
    },
    // Applying may park or reject the effort, which `holds` would then refuse; only the claimant matters here.
    validate: (c) => parseDoc(readText(c, featRel(slug))).data.claimed_by === claimant,
  }).catch((e) => { if (e instanceof NotHolder) return { ok: false, reason: 'replaced' }; throw e; });
  if (r.ok) return { ok: true, agentInput };
  if (r.reason === 'nothing-to-do') return { ok: true, agentInput: [] };
  return { ok: false, reason: r.reason, agentInput: [] };
}
