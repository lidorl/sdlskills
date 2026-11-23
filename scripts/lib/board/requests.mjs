// Request files: board/requests/<id>.md. A headless worker posts one instead of asking a terminal;
// a person answers by writing only that file; a later worker applies the answer.
import { stringify } from 'yaml';
import { boardWrite, BoardError } from './git.mjs';
import { release, checkSlug, featReqPath } from './claims.mjs';
import { dirTree, REQUEST_ID_RE } from './safe-path.mjs';
import { parseDoc, setFields, appendToSection, locateSection, fenceTracker } from './frontmatter.mjs';
import { safeExcerpt } from './redact.mjs';

const KINDS = ['gate', 'question', 'clarification', 'error'];
const SCOPES = ['effort', 'worker'];
const STATUSES = ['open', 'answered', 'withdrawn'];
const VIA = ['cli', 'file', 'slack'];
const ID_RE = REQUEST_ID_RE;
const SECTION_ORDER = ['Request', 'Context', 'Options', 'Assumption', 'Findings', 'Error'];

const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
function checkId(id) {
  if (!ID_RE.test(String(id))) throw new BoardError(`invalid request id "${id}"`);
  return id;
}
const reqPath = (id) => `board/requests/${checkId(id)}.md`;

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

// Level-2 section headings of a body in order, ignoring headings inside code fences.
function headings(body) {
  const inFence = fenceTracker();
  return body.split(/\r?\n/).map((line) => (!inFence(line) && /^##\s+(.+?)\s*$/.exec(line)?.[1]) || null);
}

// Level-2 sections of a body, ignoring headings inside code fences.
function parseSections(body) {
  const out = {};
  let name = null;
  const heads = headings(body);
  body.split(/\r?\n/).forEach((line, i) => {
    if (heads[i]) { name = heads[i]; out[name] = []; return; }
    if (name) out[name].push(line);
  });
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join('\n').trim()]));
}

// Agent-written section text must not open a section (or a title) of its own: a line starting with `#` or `##`
// gets one leading space. `###` and deeper (review findings) are left alone; they never end a section.
export const defangHeadings = (text) => String(text).replace(/^(#{1,2})(?!#)/gm, ' $1');

// Replace the body of the LAST `## heading` outside code fences (the Answer section is always last).
function replaceSection(text, heading, content) {
  const lines = text.split('\n');
  const sec = locateSection(lines, heading, { last: true });
  const block = [`## ${heading}`, '', ...(content ? [content, ''] : [])];
  if (!sec) return `${text.replace(/\n*$/, '\n\n')}${block.join('\n')}`;
  lines.splice(sec.start, sec.end - sec.start, ...block);
  return lines.join('\n');
}

// Notes must not be able to open a section of their own.
const defang = (notes) => notes.replace(/^(#{1,2}\s)/gm, ' $1');

// Fence longer than any backtick run inside, so log text can never close it or add headings.
export function fenced(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const f = '`'.repeat(Math.max(3, longest + 1));
  return `${f}\n${text}\n${f}`;
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
      const p = oneOf(fm.gate === 'triage' ? ['accept', 'park', 'reject'] : ['approve', 'reject']);
      if (!p && fm.gate === 'design-approval' && answer === 'reject' && !hasNotes) return 'answer "reject" requires notes';
      return p;
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
  // A later duplicate would replace the first section's text (e.g. a forged Context): refuse it.
  const seen = new Set();
  for (const h of headings(parsed.body).filter(Boolean)) {
    if (seen.has(h)) p.push(`duplicate section ## ${h}`);
    seen.add(h);
  }
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

function parseRequest(text) {
  const { data, body } = parseDoc(text);
  return { fm: data, sections: parseSections(body) };
}

const asTree = (root) => (typeof root === 'string' ? dirTree(root) : root);

// Only files named <request id>.md are requests; anything else in board/requests/ is reported.
// `root` is a directory or a content tree (a protocol write's mutate tree); `path` is repo-relative.
export function listRequests(root) {
  const tree = asTree(root);
  const requests = [];
  const problems = [];
  let names;
  try { names = tree.list('board/requests'); } catch (e) { return { requests, problems: [`board/requests: ${e.message}`] }; }
  for (const name of names.filter((n) => n.endsWith('.md'))) {
    const id = name.slice(0, -3);
    if (!ID_RE.test(id)) { problems.push(`${name}: not a request id (YYYYMMDDHHMM-xxxxxx)`); continue; }
    try {
      const path = `board/requests/${name}`;
      const { fm, sections } = parseRequest(tree.read(path));
      requests.push({ id: fm.id ?? id, path, fm, sections });
    } catch (e) {
      problems.push(`${name}: ${e.message}`);
    }
  }
  return { requests, problems };
}

export function answeredFor(root, slug) {
  return listRequests(root).requests.filter((r) => r.fm.status === 'answered' && r.fm.effort === slug);
}

export async function postRequest(clone, req, { identity, workerId, releaseFrom, sleep, hooks }) {
  const id = checkId(req.id);
  if (req.effort != null) checkSlug(req.effort);
  if (releaseFrom) checkSlug(releaseFrom.slug);
  const sections = { ...req.sections };
  if (sections.Error != null) sections.Error = fenced(safeExcerpt(String(sections.Error)).text);
  const slugOk = releaseFrom?.slug === req.effort;
  if (req.blocking && req.scope === 'effort' && !(releaseFrom && slugOk)) return { ok: false, reason: 'needs-release' };
  const text = buildRequest({ ...req, sections });
  const problems = validateRequest(text, `${id}.md`);
  if (problems.length) return { ok: false, reason: 'invalid', problems };
  const trailers = { request: id, ...(req.effort ? { effort: req.effort } : {}) };
  const writeFile = (tree) => tree.write(reqPath(id), text);

  if (req.blocking && releaseFrom) {
    const { slug, claimant } = releaseFrom;
    const r = await release(clone, slug, {
      claimant, identity, workerId, hooks, kind: 'request', subject: id, trailers: { request: id },
      extraMutate: (tree) => {
        const f = featReqPath(slug);
        tree.write(f, setFields(tree.read(f), { awaiting: id }));
        writeFile(tree);
      },
    });
    return r.ok ? { ok: true, id } : { ok: false, reason: r.reason };
  }

  const r = await boardWrite(clone, {
    kind: 'request', subject: id, identity, onReject: 'rebase', commitFromHead: true, sleep, hooks,
    trailers: { ...(workerId ? { worker: workerId } : {}), ...trailers },
    mutate: writeFile,
    validate: (view) => view.exists(reqPath(id)),
  });
  return r.ok ? { ok: true, id } : { ok: false, reason: r.reason };
}

export async function answerRequest(clone, id, { answer, notes, by, via = 'cli', identity, now, sleep, hooks }) {
  checkId(id);
  const stamp = iso(now);
  let refusal = null;
  const r = await boardWrite(clone, {
    kind: 'answer', subject: id, identity, onReject: 'rebase', commitFromHead: true, sleep, hooks,
    trailers: { request: id, answeredBy: by },
    mutate: (tree) => {
      refusal = null;
      const current = tree.read(reqPath(id));
      if (current === null) { refusal = 'missing'; return; }
      const { fm, sections } = parseRequest(current);
      if (fm.status !== 'open') { refusal = 'not-open'; return; }
      if (answerProblem(fm, sections, answer, notes)) { refusal = 'invalid-answer'; return; }
      let text = setFields(current, {
        status: 'answered', answer, answered_by: by, answered_at: stamp, answered_via: via,
      });
      text = replaceSection(text, 'Answer', defang(notes?.trim() ?? ''));
      tree.write(reqPath(id), text);
    },
    validate: (view) => {
      const text = view.read(reqPath(id));
      if (text === null) return false;
      const { fm } = parseRequest(text);
      return fm.answered_by === by && fm.answered_at === stamp;
    },
  });
  if (r.ok) return { ok: true };
  if (r.reason === 'nothing-to-do' && refusal) return { ok: false, reason: refusal };
  return { ok: false, reason: r.reason };
}

export async function withdrawRequest(clone, id, { identity, workerId, slug, note, sleep, hooks }) {
  checkId(id);
  if (slug != null) checkSlug(slug);
  let refusal = null;
  const r = await boardWrite(clone, {
    kind: 'withdraw', subject: id, identity, onReject: 'rebase', commitFromHead: true, sleep, hooks,
    trailers: { ...(workerId ? { worker: workerId } : {}), ...(slug ? { effort: slug } : {}), request: id },
    mutate: (tree) => {
      refusal = null;
      const current = tree.read(reqPath(id));
      if (current === null) { refusal = 'missing'; return; }
      if (parseRequest(current).fm.status !== 'open') { refusal = 'not-open'; return; }
      tree.remove(reqPath(id));
      let text = slug ? tree.read(featReqPath(slug)) : null;
      if (text !== null) {
        if (parseDoc(text).data.awaiting === id) text = setFields(text, { awaiting: null });
        if (note) text = appendToSection(text, 'Decisions', note);
        tree.write(featReqPath(slug), text);
      }
    },
    validate: (view) => !view.exists(reqPath(id)),
  });
  if (r.ok) return { ok: true };
  if (r.reason === 'nothing-to-do' && refusal) return { ok: false, reason: refusal };
  return { ok: false, reason: r.reason };
}
