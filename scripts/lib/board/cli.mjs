// `sdlc` board commands: a thin dispatcher over the board library. All protocol logic lives in
// the sibling modules; this file parses argv, calls them, and renders results.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { assertOnMain, identityEnv, fetchMain, snapshotMain } from './git.mjs';
import { claim, release, committedFm, featReqPath } from './claims.mjs';
import { loadEfforts, rank, overlaps } from './queue.mjs';
import { listRequests, validateRequest, answerRequest } from './requests.mjs';
import { boardView, listWorkers } from './registry.mjs';
import { parseLog } from './events.mjs';
import { loadConfig, validateConfig, boardEnabled, parseDuration } from './config.mjs';
import { safePath, SLUG_RE, REQUEST_ID_RE } from './safe-path.mjs';
import { loadCatalog } from '../catalog.mjs';
import { reportPaths } from './paths.mjs';
import { reportEffort } from './report.mjs';
import { runWorker } from '../worker/cli.mjs';

export { reportPaths };
import { createInterface } from 'node:readline/promises';

const PHASES = ['ACCEPTED', 'DESIGNED', 'PLANNED', 'IN_PROGRESS', 'IMPLEMENTED'];

class UsageError extends Error {}

// name -> { flags: { --flag: 'bool' | 'value' }, positional: n }
const COMMANDS = {
  check: { flags: { '--json': 'bool' }, positional: 0 },
  next: { flags: { '--json': 'bool' }, positional: 0 },
  claim: { flags: {}, positional: 1 },
  report: { flags: { '--phase': 'value', '--paths': 'value' }, positional: 1 },
  release: { flags: {}, positional: 1 },
  status: { flags: { '--json': 'bool' }, positional: 0 },
  inbox: { flags: { '--all': 'bool', '--json': 'bool' }, positional: 0 },
  answer: { flags: { '--choice': 'value', '--note': 'value' }, positional: 1 },
  watch: {
    flags: { '--interval': 'value', '--json': 'bool', '--since': 'value', '--max-polls': 'value' }, positional: 0,
  },
};

function parseArgs(spec, argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    let inline = null;
    const eq = a.indexOf('=');
    if (eq > 0) { inline = a.slice(eq + 1); a = a.slice(0, eq); }
    const kind = spec.flags[a];
    if (!kind) throw new UsageError(`unknown option ${a}`);
    if (kind === 'bool') { flags[a] = true; continue; }
    const v = inline ?? argv[++i];
    if (v === undefined) throw new UsageError(`${a} needs a value`);
    flags[a] = v;
  }
  if (positional.length !== spec.positional) throw new UsageError(`expected ${spec.positional} argument(s), got ${positional.length}`);
  return { flags, positional };
}

const gitOut = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// Read commands never touch the clone's branch or files: fetch origin/main (a failure is a warning), then
// read the board from a throwaway copy of origin/main's docs/ and board/.
async function withMainBoard(root, deps, fn) {
  try { fetchMain(root); } catch (e) { deps.err(`warning: could not refresh from origin/main: ${firstLine(e)}\n`); }
  const snap = snapshotMain(root);
  try { return await fn(snap.dir); } finally { snap.cleanup(); }
}

const firstLine = (e) => String(e.message).split('\n')[0];

function readonlyKeys(root) {
  try {
    return new Set(Object.entries(loadCatalog(root).repos).filter(([, r]) => r.readonly).map(([k]) => k));
  } catch {
    return new Set();
  }
}

const openRequestIds = (root) => new Set(listRequests(root).requests.filter((r) => r.fm.status === 'open').map((r) => r.id));

function warnOverlaps(deps, slug, list) {
  for (const o of list) deps.err(`warning: ${slug} shares ${o.repos.join(', ')} with ${o.slug}\n`);
}

const table = (head, rows) => {
  const all = [head, ...rows];
  const w = head.map((_, i) => Math.max(...all.map((r) => String(r[i] ?? '').length)));
  return all.map((r) => r.map((c, i) => String(c ?? '').padEnd(w[i])).join('  ').trimEnd()).join('\n');
};

const age = (ms) => {
  const m = Math.floor(ms / 60000);
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h${m % 60}m` : `${Math.floor(m / 1440)}d`;
};

// ---- commands -------------------------------------------------------------------------------

function cmdCheck(root, args, deps) {
  return withMainBoard(root, deps, (board) => checkBoard(board, args, deps));
}

function checkBoard(root, { flags }, deps) {
  const problems = [];
  const add = (file, problem) => problems.push({ file, problem });
  const read = (rel) => readFileSync(safePath(root, rel), 'utf8');
  const list = (rel, ext) => {
    try {
      const dir = safePath(root, rel);
      return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(ext)).sort() : [];
    } catch (e) { add(rel, firstLine(e)); return []; }
  };
  try {
    if (existsSync(safePath(root, 'board/config.yml'))) {
      const text = read('board/config.yml');
      let cfg;
      try { cfg = parse(text) ?? {}; } catch (e) { throw new Error(`invalid YAML: ${firstLine(e)}`); }
      for (const p of validateConfig(cfg)) add('board/config.yml', p);
    }
  } catch (e) { add('board/config.yml', firstLine(e)); }
  for (const n of list('board/requests', '.md')) {
    const rel = `board/requests/${n}`;
    try {
      for (const p of validateRequest(read(rel), n)) add(rel, p);
    } catch (e) { add(rel, firstLine(e)); }
  }
  for (const n of list('board/workers', '.yml')) {
    const rel = `board/workers/${n}`;
    let text;
    try { text = read(rel); } catch (e) { add(rel, firstLine(e)); continue; }
    try {
      const w = parse(text);
      if (!w || typeof w !== 'object') add(rel, 'must be a mapping');
      else if (w.id !== n.slice(0, -4)) add(rel, `id "${w.id}" must match the filename`);
    } catch (e) { add(rel, `invalid YAML: ${firstLine(e)}`); }
  }
  for (const p of loadEfforts(root).problems) add(p.file, p.message);
  if (flags['--json']) deps.out(`${JSON.stringify({ ok: problems.length === 0, problems })}\n`);
  else for (const p of problems) deps.err(`${p.file}: ${p.problem}\n`);
  if (!flags['--json'] && !problems.length) deps.out('board ok\n');
  return problems.length ? 1 : 0;
}

function cmdNext(root, args, deps) {
  return withMainBoard(root, deps, (board) => nextOn(root, board, args, deps));
}

function nextOn(root, board, { flags }, deps) {
  const cfg = loadConfig(board);
  const now = deps.now();
  const { efforts } = loadEfforts(board);
  const ranked = rank(efforts, { now, ttlMs: cfg.leaseTtlMs, openRequestIds: openRequestIds(board) });
  const next = ranked[0] ?? null;
  const ov = next ? overlaps(next, efforts, { now, ttlMs: cfg.leaseTtlMs, readonlyKeys: readonlyKeys(root) }) : [];
  if (flags['--json']) { deps.out(`${JSON.stringify({ next, overlaps: ov })}\n`); return 0; }
  if (!next) { deps.out('nothing to pick up\n'); return 0; }
  deps.out(`next: ${next.slug} (${next.status}${next.priority ? `, ${next.priority}` : ''})\n`);
  warnOverlaps(deps, next.slug, ov);
  return 0;
}

// fn(dir) over a throwaway copy of origin/main's docs/ and board/ (no fetch; the caller has fetched).
function onMainCopy(root, fn) {
  const snap = snapshotMain(root);
  try { return fn(snap.dir); } finally { snap.cleanup(); }
}

// Claiming is a protocol write: everything it decides or reports comes from origin/main, never the local tree.
async function cmdClaim(root, { positional: [slug] }, deps) {
  assertOnMain(root);
  const id = deps.whoami();
  fetchMain(root, identityEnv(id));
  const cfg = onMainCopy(root, loadConfig);
  const now = deps.now();
  const r = await claim(root, slug, { claimant: id.login, identity: id, now, ttlMs: cfg.leaseTtlMs });
  if (!r.ok) {
    const fm = committedFm(root, slug, 'origin/main');
    const why = {
      gone: `no such effort ${slug}`, held: `${slug} is held by ${fm?.claimed_by}`, closed: `${slug} is ${fm?.status}; not claimable`,
      awaiting: `${slug} is waiting on an open request`,
      blocked: `blocked: ${slug} waits on ${(r.waitingOn ?? []).map((d) => `${d} (${SLUG_RE.test(d) ? committedFm(root, d, 'origin/main')?.status ?? 'missing' : 'missing'})`).join(', ')}`, mismatch: `${slug} changed while claiming; try again`,
    }[r.reason] ?? `could not claim ${slug} (${r.reason})`;
    deps.err(`${why}\n`);
    return 1;
  }
  deps.out(r.takeover ? `claimed ${slug} (took over from ${r.takeover})\n` : `claimed ${slug}\n`);
  const ov = onMainCopy(root, (board) => {
    const { efforts } = loadEfforts(board);
    const mine = efforts.find((e) => e.slug === slug);
    return mine ? overlaps(mine, efforts, { now, ttlMs: cfg.leaseTtlMs, readonlyKeys: readonlyKeys(root) }) : [];
  });
  warnOverlaps(deps, slug, ov);
  return 0;
}

async function cmdReport(root, { flags, positional: [slug] }, deps) {
  const phase = flags['--phase'];
  if (!PHASES.includes(phase)) throw new UsageError(`--phase must be one of ${PHASES.join('|')}`);
  const extra = flags['--paths'] ? flags['--paths'].split(',').map((s) => s.trim()).filter(Boolean) : [];
  try { reportPaths(root, slug, extra); } catch (e) { throw new UsageError(firstLine(e)); }
  assertOnMain(root);
  const id = deps.whoami();
  const feat = featReqPath(slug);
  const lost = (why, res = {}) => {
    const up = committedFm(root, slug, 'origin/main');
    if (why === 'closed') deps.err(`${slug} is ${up?.status} on main; nothing was pushed\n`);
    else if (why === 'landed') deps.err(`${slug}: report landed but ${slug} is now held by ${up?.claimed_by}\n`);
    else if (why === 'race') deps.err(`${slug}: lost the race to push the report; nothing was pushed\n`);
    else {
      deps.err(up?.claimed_by
        ? `${slug} is now held by ${up.claimed_by}; nothing was pushed\n`
        : `${slug} is not claimed by ${id.login}; nothing was pushed\n`);
    }
    if (res.kept?.length) deps.err(`kept your uncommitted work: ${res.kept.join(', ')}\n`);
    if (res.conflicted?.length) deps.err(`changed upstream too; your version saved beside it as <path>.ours-<sha>: ${res.conflicted.join(', ')}\n`);
    if (res.dropped) deps.err(`your edits to ${feat} were not kept (main's copy wins); redo them once you hold ${slug} again\n`);
    return 3;
  };
  const r = await reportEffort(root, slug, {
    phase, claimant: id.login, identity: id, extraPaths: extra, now: deps.now(), sleep: deps.sleep, hooks: deps.hooks,
  });
  if (r.ok) { deps.out(`reported ${slug} at ${phase}\n`); return 0; }
  if (r.reason === 'not-holder' || r.reason === 'closed' || r.reason === 'landed') return lost(r.reason);
  if (r.reason === 'conflict') return lost('not-holder', { ...r, dropped: true });
  if (r.reason === 'race') return lost('race', { ...r, dropped: true });
  if (r.reason === 'unmerged') {
    deps.err(`your edits to ${r.paths.join(', ')} conflict with origin/main; nothing was pushed and your files are untouched\n`);
    return 1;
  }
  deps.err(`could not report ${slug} (${r.reason})\n`);
  return 1;
}

async function cmdRelease(root, { positional: [slug] }, deps) {
  assertOnMain(root);
  const id = deps.whoami();
  const r = await release(root, slug, { claimant: id.login, identity: id });
  if (r.ok) { deps.out(`released ${slug}\n`); return 0; }
  deps.err(r.reason === 'replaced' ? `${slug} is not claimed by ${id.login}; nothing was pushed\n` : `could not release ${slug} (${r.reason})\n`);
  return 1;
}

function cmdStatus(root, args, deps) {
  return withMainBoard(root, deps, (board) => statusOn(root, board, args, deps));
}

function statusOn(root, board, { flags }, deps) {
  const cfg = loadConfig(board);
  let events;
  try { events = parseLog(root, { ref: 'origin/main' }); } catch { events = []; }
  const view = boardView(board, { now: deps.now(), ttlMs: cfg.leaseTtlMs, events });
  if (flags['--json']) { deps.out(`${JSON.stringify(view)}\n`); return 0; }
  const ts = (v) => (v ? new Date(v).toISOString().slice(0, 16).replace('T', ' ') : '-');
  deps.out(`Workers\n${table(['id', 'owner', 'state', 'effort', 'last seen'],
    view.workers.map((w) => [w.id, w.owner, w.state, w.effort ?? '-', ts(w.lastSeen)]))}\n\n`);
  const inbox = Object.entries(view.inbox).flatMap(([who, list]) => list.map((r) => [r.id, who, r.fm.kind, r.fm.effort ?? '-']));
  deps.out(`Inbox\n${table(['id', 'for', 'kind', 'effort'], inbox)}\n\n`);
  deps.out(`In flight\n${table(['effort', 'status', 'claimant', 'age', 'stale'],
    view.inFlight.map((e) => [e.slug, e.status, e.claimant, age(e.claimAgeMs), e.stale ? 'yes' : '']))}\n`);
  return 0;
}

function cmdInbox(root, args, deps) {
  const login = deps.whoami().login;
  return withMainBoard(root, deps, (board) => inboxOn(board, login, args, deps));
}

function inboxOn(root, login, { flags }, deps) {
  const mine = (r) => flags['--all'] || r.fm.for === login || r.fm.for === 'approvers';
  const time = (r) => new Date(r.fm.created_at).getTime() || 0;
  const rows = listRequests(root).requests
    .filter((r) => r.fm.status === 'open' && mine(r))
    .sort((a, b) => time(a) - time(b) || a.id.localeCompare(b.id));
  if (flags['--json']) {
    deps.out(`${JSON.stringify(rows.map((r) => ({
      id: r.id, kind: r.fm.kind, gate: r.fm.gate ?? null, effort: r.fm.effort ?? null, for: r.fm.for,
      blocking: r.fm.blocking, created_at: r.fm.created_at,
    })))}\n`);
    return 0;
  }
  if (!rows.length) { deps.out('inbox is empty\n'); return 0; }
  deps.out(`${table(['id', 'for', 'kind', 'effort'], rows.map((r) => [r.id, r.fm.for, r.fm.gate ?? r.fm.kind, r.fm.effort ?? '-']))}\n`);
  return 0;
}

const parseChoices = (s) => Object.fromEntries(s.split(',').map((p) => {
  const [k, v] = p.split('=').map((x) => x.trim());
  if (!k || !v) throw new UsageError(`--choice entries must look like F1=fix, got "${p}"`);
  return [k, v];
}));

// Numbered prompts on stdin/stdout. cli.mjs ships to adopters, and the installer-only ui.mjs does not, so no import.
function plainUi() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => rl.question(q);
  const select = async ({ message, choices }) => {
    for (;;) {
      const a = (await ask(`${message} (${choices.map((c, i) => `${i + 1}=${c.label}`).join(', ')}): `)).trim();
      const hit = choices.find((c, i) => a === String(i + 1) || a === c.value);
      if (hit) return hit.value;
    }
  };
  return { ask, select, close: () => rl.close() };
}

async function promptAnswer(req, deps) {
  const ui = deps.ui ?? plainUi();
  try { return await promptWith(ui, req); } finally { ui.close?.(); }
}

async function promptWith(ui, req) {
  const pick = (message, values) => ui.select({ message, choices: values.map((v) => ({ label: v, value: v })) });
  const { kind, gate, scope } = req.fm;
  let answer;
  if (kind === 'gate' && gate === 'review-findings') {
    answer = {};
    for (const m of (req.sections.Findings ?? '').matchAll(/^###\s+(F\d+)\b/gm)) {
      answer[m[1]] = await pick(`${m[1]}`, ['fix', 'accept']);
      if (answer[m[1]] === null) return null;
    }
  } else if (kind === 'gate') {
    answer = await pick('Answer', gate === 'triage' ? ['accept', 'park', 'reject'] : ['approve', 'reject']);
  } else if (kind === 'clarification') {
    answer = await pick('Answer', ['confirm', 'correct']);
  } else if (kind === 'error') {
    answer = await pick('Answer', scope === 'worker' ? ['resolved'] : ['retry', 'park', 'text']);
  } else {
    answer = (await ui.ask('Option letter (or "text"): '))?.trim();
  }
  if (!answer) return null;
  let notes;
  if (answer === 'text' || answer === 'correct') notes = (await ui.ask('Notes: '))?.trim();
  return { answer, notes };
}

// Answering is a protocol write: read the request from origin/main and never touch the local tree.
async function cmdAnswer(root, { flags, positional: [id] }, deps) {
  assertOnMain(root);
  const ident = deps.whoami();
  fetchMain(root, identityEnv(ident));
  const req = onMainCopy(root, (board) => listRequests(board).requests.find((r) => r.id === id));
  if (!req || req.fm.status !== 'open') { deps.err(`no such open request ${id}\n`); return 1; }
  let answer;
  let notes = flags['--note'];
  if (flags['--choice'] !== undefined) {
    const review = req.fm.kind === 'gate' && req.fm.gate === 'review-findings';
    answer = review ? parseChoices(flags['--choice']) : flags['--choice'];
  } else if (deps.interactive ?? (process.stdin.isTTY && process.stdout.isTTY)) {
    const got = await promptAnswer(req, deps);
    if (!got) { deps.err('cancelled\n'); return 1; }
    answer = got.answer;
    notes ??= got.notes;
  } else {
    throw new UsageError('answer needs --choice (or run it in a terminal)');
  }
  const r = await answerRequest(root, id, { answer, notes, by: ident.login, via: 'cli', identity: ident, now: deps.now(), sleep: deps.sleep });
  if (r.ok) { deps.out(`answered ${id}\n`); return 0; }
  deps.err(r.reason === 'missing' || r.reason === 'not-open' ? `no such open request ${id}\n`
    : r.reason === 'invalid-answer' ? `that answer does not fit request ${id}; see its Options or Findings\n`
      : `could not answer ${id} (${r.reason})\n`);
  return 1;
}

async function cmdWatch(root, { flags }, deps) {
  const cfg = loadConfig(root);
  const interval = flags['--interval'] ? parseDuration(flags['--interval']) : cfg.watchIntervalMs;
  const max = flags['--max-polls'] === undefined ? Infinity : Number(flags['--max-polls']);
  if (!(max >= 1)) throw new UsageError('--max-polls must be a positive integer');
  if (flags['--since'] !== undefined && !/^[0-9a-f]{7,40}$/.test(flags['--since'])) throw new UsageError('--since must be a commit sha (7-40 hex chars)');
  const tip = () => gitOut(root, ['rev-parse', 'origin/main']).trim();
  const refresh = () => { try { fetchMain(root); } catch (e) { deps.err(`warning: could not refresh from origin/main: ${firstLine(e)}\n`); } };
  refresh();
  let last = flags['--since'] ?? tip();
  for (let poll = 1; poll <= max; poll++) {
    if (poll > 1) { await deps.sleep(interval); refresh(); }
    const events = parseLog(root, { sinceSha: last }).reverse();
    for (const e of events) {
      if (flags['--json']) deps.out(`${JSON.stringify(e)}\n`);
      else {
        const who = e.worker ?? e.author;
        deps.out(`${e.at.toISOString()}  ${e.kind}  ${e.subject}${e.effort && e.effort !== e.subject ? ` [${e.effort}]` : ''}  (${who})\n`);
      }
    }
    last = tip();
  }
  return 0;
}

const HANDLERS = {
  check: cmdCheck, next: cmdNext, claim: cmdClaim, report: cmdReport, release: cmdRelease,
  status: cmdStatus, inbox: cmdInbox, answer: cmdAnswer, watch: cmdWatch,
};
const SLUG_COMMANDS = new Set(['claim', 'report', 'release']);
const USAGE = `usage: sdlc <command>
  check | next | status | inbox [--all] | watch [--interval 30s] [--since <sha>]
  claim <slug> | report <slug> --phase <STATUS> [--paths a,b] | release <slug>
  answer <id> [--choice X] [--note "..."]   (add --json where supported)
  worker <command>   (create, start, once, stop, status, list, retire, config; see sdlc worker)
`;

export async function run(argv, deps) {
  const { cwd = process.cwd() } = deps;
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'worker') return await runWorker(rest, deps);
    if (!cmd || !COMMANDS[cmd]) throw new UsageError(cmd ? `unknown command ${cmd}` : 'missing command');
    const args = parseArgs(COMMANDS[cmd], rest);
    if (SLUG_COMMANDS.has(cmd) && !SLUG_RE.test(args.positional[0])) throw new UsageError(`invalid slug "${args.positional[0]}"`);
    if (cmd === 'answer' && !REQUEST_ID_RE.test(args.positional[0])) throw new UsageError(`invalid request id "${args.positional[0]}"`);
    if (!boardEnabled(cwd)) { deps.err('not a board repo: no board/ directory here\n'); return 1; }
    return await HANDLERS[cmd](cwd, args, deps);
  } catch (e) {
    if (e instanceof UsageError) { deps.err(`${e.message}\n${USAGE}`); return 2; }
    deps.err(`${firstLine(e)}\n`);
    return 1;
  }
}
