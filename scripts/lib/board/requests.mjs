// Request files: board/requests/<id>.md. A headless worker posts one instead of asking a terminal;
// a person answers by writing only that file; a later worker applies the answer.
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { stringify } from 'yaml';
import { boardWrite } from './git.mjs';
import { release } from './claims.mjs';
import { parseDoc, setFields, appendToSection } from './frontmatter.mjs';
import { safeExcerpt } from './redact.mjs';

const KINDS = ['gate', 'question', 'clarification', 'error'];
const SCOPES = ['effort', 'worker'];
const STATUSES = ['open', 'answered', 'withdrawn'];
const VIA = ['cli', 'file', 'slack'];
const ID_RE = /^\d{12}-[a-z0-9]{6}$/;
const SECTION_ORDER = ['Request', 'Context', 'Options', 'Assumption', 'Findings', 'Error'];

const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const reqPath = (id) => `board/requests/${id}.md`;
const featPath = (slug) => `docs/feat-req/${slug}.md`;

export function newRequestId(now, rand = Math.random) {
  const stamp = iso(now).replace(/[-:TZ]/g, '').slice(0, 12);
  let suffix = '';
  for (let i = 0; i < 6; i++) suffix += Math.floor(rand() * 36).toString(36);
  return `${stamp}-${suffix}`;
}

export function buildRequest({ id, kind, gate = null, scope, effort = null, phase = null, worker, for: forWho, blocking, now, sections = {} }) {
  const fm = {
    id, kind, gate, scope, effort, phase, worker, for: forWho, blocking, status: 'open',
    created_at: iso(now), answered_by: null, answered_at: null, answered_via: null, answer: null, external: {},
  };
  const body = SECTION_ORDER.filter((h) => sections[h] != null)
    .map((h) => `## ${h}\n\n${String(sections[h]).trim()}\n`);
  body.push('## Answer\n');
  return `---\n${stringify(fm, { lineWidth: 0 })}---\n\n${body.join('\n')}`;
}

// Level-2 sections of a body, ignoring headings inside code fences.
function parseSections(body) {
  const out = {};
  let name = null;
  let fence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && /^##\s+(.+?)\s*$/.exec(line);
    if (m) { name = m[1]; out[name] = []; continue; }
    if (name) out[name].push(line);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join('\n').trim()]));
}

function replaceSection(text, heading, content) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  const block = [`## ${heading}`, '', ...(content ? [content, ''] : [])];
  if (start === -1) return `${text.replace(/\n*$/, '\n\n')}${block.join('\n')}`;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^#{1,2}\s/.test(lines[i])) { end = i; break; }
  lines.splice(start, end - start, ...block);
  return lines.join('\n');
}

const findingIds = (findings = '') => [...findings.matchAll(/^###\s+(F\d+)\b/gm)].map((m) => m[1]);

function optionLetters(options = '') {
  const letters = new Set();
  for (const line of options.split('\n')) {
    const m = /^\s*(?:[-*]\s+)?(?:\*\*([A-Z])\*\*|([A-Z])[).])(?=\s|$|[:\-–—.)])/.exec(line);
    if (m) letters.add(m[1] ?? m[2]);
  }
  return letters;
}

// Returns a problem string, or null when `answer` (with the answer notes) fits the request.
function answerProblem(fm, sections, answer, notes) {
  const hasNotes = !!notes?.trim();
  const oneOf = (list) => (typeof answer === 'string' && list.includes(answer) ? null : `answer must be one of ${list.join('|')}`);
  switch (fm.kind) {
    case 'gate': {
      if (fm.gate === 'review-findings') {
        const ids = findingIds(sections.Findings);
        if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return 'answer must be a map of finding id to fix|accept';
        const keys = Object.keys(answer);
        if (keys.length !== ids.length || !ids.every((i) => i in answer)) return `answer must cover exactly the findings ${ids.join(', ')}`;
        return keys.every((k) => answer[k] === 'fix' || answer[k] === 'accept') ? null : 'each finding answer must be fix or accept';
      }
      return oneOf(fm.gate === 'triage' ? ['accept', 'park', 'reject'] : ['approve', 'reject']);
    }
    case 'question': {
      if (answer === 'text') return hasNotes ? null : 'answer "text" requires notes';
      return typeof answer === 'string' && optionLetters(sections.Options).has(answer) ? null : 'answer must be an option letter listed in Options, or "text"';
    }
    case 'clarification': {
      const p = oneOf(['confirm', 'correct']);
      return p ?? (answer === 'correct' && !hasNotes ? 'answer "correct" requires notes' : null);
    }
    case 'error': {
      if (fm.scope === 'worker') return oneOf(['resolved']);
      const p = oneOf(['retry', 'park', 'text']);
      return p ?? (answer === 'text' && !hasNotes ? 'answer "text" requires notes' : null);
    }
    default: return 'unknown kind';
  }
}

export function validateRequest(text, filename) {
  let parsed;
  try { parsed = parseDoc(text); } catch (e) { return [`frontmatter: ${e.message}`]; }
  const fm = parsed.data;
  const sections = parseSections(parsed.body);
  const p = [];
  if (!ID_RE.test(String(fm.id ?? ''))) p.push(`id "${fm.id}" must match YYYYMMDDHHMM-xxxxxx`);
  if (filename !== `${fm.id}.md`) p.push(`filename ${filename} must be ${fm.id}.md`);
  if (!KINDS.includes(fm.kind)) p.push(`kind "${fm.kind}" must be one of ${KINDS.join('|')}`);
  if (!SCOPES.includes(fm.scope)) p.push(`scope "${fm.scope}" must be one of ${SCOPES.join('|')}`);
  if (!STATUSES.includes(fm.status)) p.push(`status "${fm.status}" must be one of ${STATUSES.join('|')}`);
  const via = fm.answered_via ?? null;
  if (via !== null && !VIA.includes(via)) p.push(`answered_via "${via}" must be one of ${VIA.join('|')}|null`);
  if (fm.kind === 'gate' && !fm.gate) p.push('gate is required for kind gate');
  if (fm.scope === 'effort' && !fm.effort) p.push('effort is required for scope effort');
  if (typeof fm.for !== 'string' || !fm.for.trim()) p.push('for must be a non-empty string');
  if (typeof fm.blocking !== 'boolean') p.push('blocking must be true or false');
  else if (!fm.blocking && fm.kind !== 'clarification') p.push('blocking: false is allowed only for clarifications');
  if (!fm.created_at) p.push('created_at is required');
  for (const h of ['Request', 'Context']) if (!sections[h]) p.push(`## ${h} section is required`);
  if (fm.kind === 'question' && !sections.Options) p.push('## Options section is required for a question');
  if (fm.kind === 'clarification' && !sections.Assumption) p.push('## Assumption section is required for a clarification');
  if (fm.kind === 'error' && !sections.Error) p.push('## Error section is required for an error');
  if (fm.kind === 'gate' && fm.gate === 'review-findings' && findingIds(sections.Findings).length === 0) {
    p.push('## Findings section with at least one ### F<n> is required for a review gate');
  }
  if (fm.status === 'answered') {
    if (!fm.answered_by) p.push('answered_by is required when answered');
    if (!fm.answered_at) p.push('answered_at is required when answered');
    const bad = KINDS.includes(fm.kind) ? answerProblem(fm, sections, fm.answer, sections.Answer) : null;
    if (bad) p.push(bad);
  }
  return p;
}

function readRequest(file) {
  const { data, body } = parseDoc(readFileSync(file, 'utf8'));
  return { fm: data, sections: parseSections(body) };
}

export function listRequests(root) {
  const dir = join(root, 'board/requests');
  const requests = [];
  const problems = [];
  if (!existsSync(dir)) return { requests, problems };
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) {
    const path = join(dir, name);
    try {
      const { fm, sections } = readRequest(path);
      requests.push({ id: fm.id ?? name.replace(/\.md$/, ''), path, fm, sections });
    } catch (e) {
      problems.push(`${name}: ${e.message}`);
    }
  }
  return { requests, problems };
}

export function answeredFor(root, slug) {
  return listRequests(root).requests.filter((r) => r.fm.status === 'answered' && r.fm.effort === slug);
}

export async function postRequest(clone, req, { identity, workerId, releaseFrom }) {
  const sections = { ...req.sections };
  if (sections.Error != null) sections.Error = safeExcerpt(String(sections.Error)).text;
  const text = buildRequest({ ...req, sections });
  const id = req.id;
  const trailers = { request: id, ...(req.effort ? { effort: req.effort } : {}) };
  const writeFile = (c) => {
    const abs = join(c, reqPath(id));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
    return reqPath(id);
  };

  if (req.blocking && releaseFrom) {
    const { slug, claimant } = releaseFrom;
    const r = await release(clone, slug, {
      claimant, identity, workerId, kind: 'request', subject: id, trailers: { request: id },
      extraMutate: (c) => {
        const f = join(c, featPath(slug));
        writeFileSync(f, setFields(readFileSync(f, 'utf8'), { awaiting: id }));
        return [writeFile(c)];
      },
    });
    return r.ok ? { ok: true, id } : { ok: false, reason: r.reason };
  }

  const r = await boardWrite(clone, {
    kind: 'request', subject: id, identity, onReject: 'rebase',
    trailers: { ...(workerId ? { worker: workerId } : {}), ...trailers },
    mutate: (c) => [writeFile(c)],
    validate: (c) => existsSync(join(c, reqPath(id))),
  });
  return r.ok ? { ok: true, id } : { ok: false, reason: r.reason };
}

export async function answerRequest(clone, id, { answer, notes, by, via = 'cli', identity, now }) {
  const stamp = iso(now);
  let refusal = null;
  const r = await boardWrite(clone, {
    kind: 'answer', subject: id, identity, onReject: 'rebase',
    trailers: { request: id, answeredBy: by },
    mutate: (c) => {
      refusal = null;
      const file = join(c, reqPath(id));
      if (!existsSync(file)) { refusal = 'missing'; return []; }
      const { fm, sections } = readRequest(file);
      if (fm.status !== 'open') { refusal = 'not-open'; return []; }
      if (answerProblem(fm, sections, answer, notes)) { refusal = 'invalid-answer'; return []; }
      let text = setFields(readFileSync(file, 'utf8'), {
        status: 'answered', answer, answered_by: by, answered_at: stamp, answered_via: via,
      });
      text = replaceSection(text, 'Answer', notes?.trim() ?? '');
      writeFileSync(file, text);
      return [reqPath(id)];
    },
    validate: (c) => {
      const file = join(c, reqPath(id));
      if (!existsSync(file)) return false;
      const { fm } = readRequest(file);
      return fm.answered_by === by && fm.answered_at === stamp;
    },
  });
  if (r.ok) return { ok: true };
  if (r.reason === 'nothing-to-do' && refusal) return { ok: false, reason: refusal };
  return { ok: false, reason: r.reason };
}

export async function withdrawRequest(clone, id, { identity, workerId, slug, note }) {
  let refusal = null;
  const r = await boardWrite(clone, {
    kind: 'withdraw', subject: id, identity, onReject: 'rebase',
    trailers: { ...(workerId ? { worker: workerId } : {}), ...(slug ? { effort: slug } : {}), request: id },
    mutate: (c) => {
      refusal = null;
      const file = join(c, reqPath(id));
      if (!existsSync(file)) { refusal = 'missing'; return []; }
      if (readRequest(file).fm.status !== 'open') { refusal = 'not-open'; return []; }
      unlinkSync(file);
      const paths = [reqPath(id)];
      const f = join(c, featPath(slug ?? ''));
      if (slug && existsSync(f)) {
        let text = readFileSync(f, 'utf8');
        if (parseDoc(text).data.awaiting === id) text = setFields(text, { awaiting: null });
        if (note) text = appendToSection(text, 'Decisions', note);
        writeFileSync(f, text);
        paths.push(featPath(slug));
      }
      return paths;
    },
    validate: (c) => !existsSync(join(c, reqPath(id))),
  });
  if (r.ok) return { ok: true };
  if (r.reason === 'nothing-to-do' && refusal) return { ok: false, reason: refusal };
  return { ok: false, reason: r.reason };
}
