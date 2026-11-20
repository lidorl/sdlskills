// Answer effects: what happens, in the docs, once a request has been answered. Answering only writes
// the request file; the next claimant of the effort applies it all in one `apply` commit.
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { stringify } from 'yaml';
import { safePath, SLUG_RE, REQUEST_ID_RE } from './safe-path.mjs';
import { boardWrite } from './git.mjs';
import { holds } from './claims.mjs';
import { parseDoc, setFields, appendToSection } from './frontmatter.mjs';
import { buildRequest, newRequestId, validateRequest, answeredFor, listRequests } from './requests.mjs';

const LIFECYCLE = ['ACCEPTED', 'DESIGNED', 'PLANNED', 'IN_PROGRESS'];
const featRel = (slug) => `docs/feat-req/${slug}.md`;
const designRel = (slug) => `docs/design/${slug}.md`;
const requestRel = (id) => `board/requests/${id}.md`;

class NotHolder extends Error {}

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const firstLine = (s) => String(s ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';

const ID_RE = REQUEST_ID_RE;
const inside = safePath;

const exists = (root, rel) => existsSync(inside(root, rel));

function readText(root, rel) {
  return readFileSync(inside(root, rel), 'utf8');
}

// Every write and delete records the file's original content first, so a failure can undo them all.
function remember(abs, rel, journal) {
  if (journal && !journal.has(rel)) journal.set(rel, existsSync(abs) ? readFileSync(abs, 'utf8') : null);
}

function writeText(root, rel, text, journal) {
  const abs = inside(root, rel);
  remember(abs, rel, journal);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

function deleteFile(root, rel, journal) {
  const abs = inside(root, rel);
  remember(abs, rel, journal);
  unlinkSync(abs);
}

function restore(root, journal) {
  for (const [rel, original] of journal) {
    const abs = inside(root, rel);
    if (original === null) rmSync(abs, { force: true });
    else writeFileSync(abs, original);
  }
}

// docs/plans/<slug>.md, else the highest-numbered <slug>-N.md that isn't IMPLEMENTED.
function planFor(root, slug) {
  if (!exists(root, 'docs/plans')) return null;
  if (exists(root, `docs/plans/${slug}.md`)) return `docs/plans/${slug}.md`;
  const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const numbered = readdirSync(inside(root, 'docs/plans'))
    .map((n) => ({ n, m: new RegExp(`^${esc}-(\\d+)\\.md$`).exec(n) }))
    .filter((x) => x.m)
    .sort((a, b) => Number(b.m[1]) - Number(a.m[1]));
  for (const { n } of numbered) {
    if (parseDoc(readText(root, `docs/plans/${n}`)).data.status !== 'IMPLEMENTED') return `docs/plans/${n}`;
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

export function applyAnswer(root, request, { now, claimant, rand, journal }) {
  const { fm, sections } = request;
  const notes = (sections.Answer ?? '').trim();
  const answer = fm.answer;
  const slug = fm.effort;
  const id = request.id ?? fm.id;
  const none = { paths: [], agentInput: null, newRequests: [] };
  if (fm.scope === 'worker') return none;
  if (!SLUG_RE.test(String(slug)) || !ID_RE.test(String(id))) throw new Error(`unsafe request ${id} or effort ${slug}`);

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
  const touch = (rel, text) => { writeText(root, rel, text, journal); paths.add(rel); };
  const label = fm.kind === 'gate' ? (GATE_LABEL[fm.gate] ?? fm.gate) : fm.kind;

  if (fm.kind === 'gate' && fm.gate === 'design-approval') {
    decide(label, answer);
    if (answer === 'approve') {
      if (exists(root, designRel(slug))) touch(designRel(slug), setFields(readText(root, designRel(slug)), { status: 'APPROVED' }));
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

  writeText(root, featRel(slug), feat, journal);
  return { paths: [...paths], agentInput, newRequests };
}

// Validate each answered request, then apply the valid ones all-or-nothing. Invalid ones are skipped
// (file and `awaiting` stay) and reported. `candidates` are already limited to scope-effort requests.
function applyRequests(c, candidates, { claimant, now, rand }) {
  const ordered = [...candidates].sort((a, b) => (a.id < b.id ? -1 : 1));
  const problems = [];
  const agentInput = [];
  const valid = [];
  for (const req of ordered) {
    let bad = [];
    try {
      bad = validateRequest(readText(c, `board/requests/${basename(req.path)}`), basename(req.path));
    } catch (e) { bad = [e.message]; }
    if (!bad.length && !SLUG_RE.test(String(req.fm.effort))) bad = [`effort "${req.fm.effort}" is not a valid slug`];
    if (bad.length) {
      problems.push({ id: req.id, problems: bad });
      agentInput.push(`Request ${req.id} could not be applied: ${bad.join('; ')}`);
    } else valid.push(req);
  }
  const paths = new Set();
  const applied = [];
  const journal = new Map();
  try {
    for (const req of valid) {
      const eff = applyAnswer(c, req, { now, claimant, rand, journal });
      eff.paths.forEach((p) => paths.add(p));
      if (eff.agentInput) agentInput.push(`Request ${req.id} (${req.fm.kind}): ${eff.agentInput}`);
      for (const nr of eff.newRequests) {
        const text = buildRequest(nr);
        const bad = validateRequest(text, `${nr.id}.md`);
        if (bad.length) throw new Error(`follow-up triage gate invalid: ${bad.join('; ')}`);
        writeText(c, requestRel(nr.id), text, journal);
        paths.add(requestRel(nr.id));
        const f = featRel(nr.effort);
        writeText(c, f, setFields(readText(c, f), { awaiting: nr.id }), journal);
        paths.add(f);
      }
      const f = featRel(req.fm.effort);
      if (parseDoc(readText(c, f)).data.awaiting === req.id) {
        writeText(c, f, setFields(readText(c, f), { awaiting: null }), journal);
        paths.add(f);
      }
      deleteFile(c, requestRel(req.id), journal);
      paths.add(requestRel(req.id));
      applied.push(req.id);
    }
  } catch (e) {
    restore(c, journal);
    throw e;
  }
  return { paths: [...paths], agentInput, problems, applied };
}

async function retrying(run) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await run();
    if (r.reason !== 'lost-race') return r;
  }
  return { ok: false, reason: 'lost-race' };
}

export function applyAnswered(clone, slug, opts) {
  return retrying(() => applyOnce(clone, slug, opts)).then((r) => ({ agentInput: [], problems: [], ...r }));
}

async function applyOnce(clone, slug, { claimant, identity, workerId, now, rand, hooks }) {
  let result = { agentInput: [], problems: [] };
  const r = await boardWrite(clone, {
    kind: 'apply', subject: slug, identity, onReject: 'restart', hooks,
    trailers: { ...(workerId ? { worker: workerId } : {}), effort: slug },
    mutate: (c) => {
      result = { agentInput: [], problems: [] };
      if (!holds(c, slug, claimant)) throw new NotHolder(); // mutate runs before any commit
      const answered = answeredFor(c, slug).filter((q) => q.fm.scope === 'effort');
      if (answered.length === 0) return [];
      const out = applyRequests(c, answered, { claimant, now, rand });
      result = { agentInput: out.agentInput, problems: out.problems };
      return out.paths;
    },
    // Applying may park or reject the effort, which `holds` would then refuse; only the claimant matters here.
    validate: (c) => parseDoc(readText(c, featRel(slug))).data.claimed_by === claimant,
  }).catch((e) => { if (e instanceof NotHolder) return { ok: false, reason: 'replaced' }; throw e; });
  if (r.ok) return { ok: true, ...result };
  if (r.reason === 'nothing-to-do') return { ok: true, ...result };
  return { ok: false, reason: r.reason };
}

// Claim-free apply for answered requests whose effort is already IMPLEMENTED (nobody can hold it).
export async function applyClosed(clone, { identity, workerId, now, rand, hooks }) {
  const claimant = workerId ?? identity.name;
  let result = { applied: [], problems: [] };
  const r = await retrying(() => boardWrite(clone, {
    kind: 'apply', subject: 'closed', identity, onReject: 'restart', hooks,
    trailers: workerId ? { worker: workerId } : {},
    mutate: (c) => {
      result = { applied: [], problems: [] };
      const closed = [];
      const bad = [];
      for (const req of listRequests(c).requests) {
        if (req.fm.status !== 'answered' || req.fm.scope !== 'effort') continue;
        if (!SLUG_RE.test(String(req.fm.effort))) {
          bad.push({ id: req.id, problems: [`effort "${req.fm.effort}" is not a valid slug`] });
          continue;
        }
        let implemented = false;
        try {
          implemented = exists(c, featRel(req.fm.effort)) && parseDoc(readText(c, featRel(req.fm.effort))).data.status === 'IMPLEMENTED';
        } catch (e) { bad.push({ id: req.id, problems: [e.message] }); continue; }
        if (!implemented) continue;
        if (req.fm.kind !== 'clarification') {
          bad.push({ id: req.id, problems: [`a ${req.fm.kind} answer cannot be applied to an IMPLEMENTED effort`] });
          continue;
        }
        closed.push(req);
      }
      const out = closed.length ? applyRequests(c, closed, { claimant, now, rand }) : { paths: [], applied: [], problems: [] };
      result = { applied: out.applied, problems: [...bad, ...out.problems] };
      return out.paths;
    },
    validate: (c) => result.applied.every((id) => !exists(c, requestRel(id))),
  }));
  if (r.ok || r.reason === 'nothing-to-do') return { ok: true, ...result };
  return { ok: false, reason: r.reason, applied: [], problems: [] };
}
