// `sdlc` board commands: a thin dispatcher over the board library. All protocol logic lives in
// the sibling modules; this file parses argv, calls them, and renders results.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { BoardError, assertOnMain, sync, boardWrite } from './git.mjs';
import { claim, holds, release } from './claims.mjs';
import { loadEfforts, rank, overlaps } from './queue.mjs';
import { listRequests, validateRequest, answerRequest } from './requests.mjs';
import { boardView, listWorkers } from './registry.mjs';
import { parseLog } from './events.mjs';
import { loadConfig, validateConfig, boardEnabled, parseDuration } from './config.mjs';
import { safePath, SLUG_RE, REQUEST_ID_RE } from './safe-path.mjs';
import { parseDoc, setFields } from './frontmatter.mjs';
import { loadCatalog } from '../catalog.mjs';
import { createInterface } from 'node:readline/promises';

const PHASES = ['ACCEPTED', 'DESIGNED', 'PLANNED', 'IN_PROGRESS', 'IMPLEMENTED'];
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

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

const readFm = (root, slug) => {
  const f = join(root, 'docs/feat-req', `${slug}.md`);
  if (!existsSync(f)) return null;
  try { return parseDoc(readFileSync(f, 'utf8')).data ?? {}; } catch { return null; }
};

const gitOut = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// Read commands refresh the clone best-effort; a failed refresh is a warning, not a stop.
function refresh(root, deps) {
  try { sync(root); } catch (e) { deps.err(`warning: could not refresh from origin/main: ${firstLine(e)}\n`); }
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

// Which docs belong to an effort: exact names only, so `bulk` never takes `bulk-export` files.
function ownerPatterns(slug) {
  return [
    new RegExp(`^docs/feat-req/${slug}\\.md$`),
    new RegExp(`^docs/design/${slug}\\.md$`),
    new RegExp(`^docs/plans/${slug}(-\\d+)?\\.md$`),
  ];
}
const historyRe = (slug) => new RegExp(`^docs/history/[^/]*_${slug}(-\\d+)?\\.md$`);

// The files a report commits for an effort: its docs, history entries changed since origin/main, and extras.
export function reportPaths(root, slug, extra = []) {
  const out = [];
  const add = (rel) => { if (!out.includes(rel) && existsSync(join(root, rel))) out.push(rel); };
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
  for (const p of extra) {
    safePath(root, p);
    const rel = posix.normalize(p.replaceAll('\\', '/'));
    if (rel === 'board' || rel.startsWith('board/')) throw new Error(`--paths: ${p} is under board/; reports never write there`);
    if (/^docs\/(feat-req|design|plans)\//.test(rel) && ![featRe, designRe, planRe].some((re) => re.test(rel))) {
      throw new Error(`--paths: ${p} does not belong to ${slug}`);
    }
    if (!existsSync(join(root, rel))) throw new Error(`--paths: ${p} does not exist`);
    add(rel);
  }
  return out;
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

function cmdCheck(root, { flags }, deps) {
  const problems = [];
  const add = (file, problem) => problems.push({ file, problem });
  const cfgFile = join(root, 'board/config.yml');
  if (existsSync(cfgFile)) {
    try {
      for (const p of validateConfig(parse(readFileSync(cfgFile, 'utf8')) ?? {})) add('board/config.yml', p);
    } catch (e) { add('board/config.yml', `invalid YAML: ${firstLine(e)}`); }
  }
  const dir = join(root, 'board/requests');
  if (existsSync(dir)) {
    for (const n of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
      for (const p of validateRequest(readFileSync(join(dir, n), 'utf8'), n)) add(`board/requests/${n}`, p);
    }
  }
  const wdir = join(root, 'board/workers');
  if (existsSync(wdir)) {
    for (const n of readdirSync(wdir).filter((f) => f.endsWith('.yml')).sort()) {
      try {
        const w = parse(readFileSync(join(wdir, n), 'utf8'));
        if (!w || typeof w !== 'object') add(`board/workers/${n}`, 'must be a mapping');
        else if (w.id !== n.slice(0, -4)) add(`board/workers/${n}`, `id "${w.id}" must match the filename`);
      } catch (e) { add(`board/workers/${n}`, `invalid YAML: ${firstLine(e)}`); }
    }
  }
  for (const p of loadEfforts(root).problems) add(p.file.startsWith(root) ? p.file.slice(root.length + 1) : p.file, p.message);
  if (flags['--json']) deps.out(`${JSON.stringify({ ok: problems.length === 0, problems })}\n`);
  else for (const p of problems) deps.err(`${p.file}: ${p.problem}\n`);
  if (!flags['--json'] && !problems.length) deps.out('board ok\n');
  return problems.length ? 1 : 0;
}

function cmdNext(root, { flags }, deps) {
  refresh(root, deps);
  const cfg = loadConfig(root);
  const now = deps.now();
  const { efforts } = loadEfforts(root);
  const ranked = rank(efforts, { now, ttlMs: cfg.leaseTtlMs, openRequestIds: openRequestIds(root) });
  const next = ranked[0] ?? null;
  const ov = next ? overlaps(next, efforts, { now, ttlMs: cfg.leaseTtlMs, readonlyKeys: readonlyKeys(root) }) : [];
  if (flags['--json']) { deps.out(`${JSON.stringify({ next, overlaps: ov })}\n`); return 0; }
  if (!next) { deps.out('nothing to pick up\n'); return 0; }
  deps.out(`next: ${next.slug} (${next.status}${next.priority ? `, ${next.priority}` : ''})\n`);
  warnOverlaps(deps, next.slug, ov);
  return 0;
}

async function cmdClaim(root, { positional: [slug] }, deps) {
  assertOnMain(root);
  const id = deps.whoami();
  const cfg = loadConfig(root);
  const now = deps.now();
  const r = await claim(root, slug, {
    claimant: id.login, identity: id, now, ttlMs: cfg.leaseTtlMs,
    isAwaitingOpen: (fm) => openRequestIds(root).has(String(fm.awaiting)),
  });
  if (!r.ok) {
    const by = readFm(root, slug)?.claimed_by;
    const why = {
      gone: `no such effort ${slug}`, held: `${slug} is held by ${by}`,
      awaiting: `${slug} is waiting on an open request`, mismatch: `${slug} changed while claiming; try again`,
    }[r.reason] ?? `could not claim ${slug} (${r.reason})`;
    deps.err(`${why}\n`);
    return 1;
  }
  deps.out(r.takeover ? `claimed ${slug} (took over from ${r.takeover})\n` : `claimed ${slug}\n`);
  const { efforts } = loadEfforts(root);
  const mine = efforts.find((e) => e.slug === slug);
  if (mine) warnOverlaps(deps, slug, overlaps(mine, efforts, { now, ttlMs: cfg.leaseTtlMs, readonlyKeys: readonlyKeys(root) }));
  return 0;
}

async function cmdReport(root, { flags, positional: [slug] }, deps) {
  const phase = flags['--phase'];
  if (!PHASES.includes(phase)) throw new UsageError(`--phase must be one of ${PHASES.join('|')}`);
  const extra = flags['--paths'] ? flags['--paths'].split(',').map((s) => s.trim()).filter(Boolean) : [];
  try { reportPaths(root, slug, extra); } catch (e) { throw new UsageError(firstLine(e)); }
  assertOnMain(root);
  const id = deps.whoami();
  const holder = () => {
    try { return parseDoc(gitOut(root, ['show', `origin/main:docs/feat-req/${slug}.md`])).data?.claimed_by; } catch { return undefined; }
  };
  const lost = (landed = false) => {
    const by = holder();
    if (landed) deps.err(`${slug}: report landed but ${slug} is now held by ${by}\n`);
    else {
      deps.err(by
        ? `${slug} is now held by ${by}; nothing was pushed\n`
        : `${slug} is not claimed by ${id.login}; nothing was pushed\n`);
    }
    return 3;
  };
  sync(root);
  if (!holds(root, slug, id.login)) return lost();
  const stamp = iso(deps.now());
  let refused = false;
  const r = await boardWrite(root, {
    kind: 'report', subject: slug, identity: id, onReject: 'rebase', onFailure: 'keep-work', hooks: deps.hooks,
    trailers: { effort: slug, phase },
    mutate: (c) => {
      refused = false;
      if (!holds(c, slug, id.login)) { refused = true; return []; }
      const f = join(c, `docs/feat-req/${slug}.md`);
      writeFileSync(f, setFields(readFileSync(f, 'utf8'), { renewed_at: stamp }));
      return reportPaths(c, slug, extra);
    },
    validate: (c) => holds(c, slug, id.login),
  });
  if (r.ok) { deps.out(`reported ${slug} at ${phase}\n`); return 0; }
  if (refused || r.reason === 'conflict') return lost();
  if (r.reason === 'replaced') return lost(true);
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

function cmdStatus(root, { flags }, deps) {
  refresh(root, deps);
  const cfg = loadConfig(root);
  const view = boardView(root, { now: deps.now(), ttlMs: cfg.leaseTtlMs });
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

function cmdInbox(root, { flags }, deps) {
  refresh(root, deps);
  const login = deps.whoami().login;
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

async function cmdAnswer(root, { flags, positional: [id] }, deps) {
  assertOnMain(root);
  const ident = deps.whoami();
  sync(root);
  const req = listRequests(root).requests.find((r) => r.id === id);
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
  const r = await answerRequest(root, id, { answer, notes, by: ident.login, via: 'cli', identity: ident, now: deps.now() });
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
  refresh(root, deps);
  let last = flags['--since'] ?? tip();
  for (let poll = 1; poll <= max; poll++) {
    if (poll > 1) { await deps.sleep(interval); refresh(root, deps); }
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
`;

export async function run(argv, deps) {
  const { cwd = process.cwd() } = deps;
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'worker') {
      const mod = fileURLToPath(new URL('../worker/cli.mjs', import.meta.url));
      if (existsSync(mod)) return await (await import(pathToFileURL(mod).href)).run(rest, deps);
      deps.err('workers arrive in a later release\n');
      return 2;
    }
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
