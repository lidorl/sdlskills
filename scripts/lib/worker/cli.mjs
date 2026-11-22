// `sdlc worker <command>`: create, start, once, stop, status, list, retire, config. The lifecycle of
// docs/design/workers.md "Worker home and lifecycle": argv parsing, the run session around loop.step(), and
// the protocol writes for the lifecycle events. Exit codes: 0 ok, 1 refusal or failure, 2 usage.
import { spawn as realSpawn, execFileSync } from 'node:child_process';
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import { parse } from 'yaml';
import { boardWrite, fetchMain, snapshotMain, identityEnv } from '../board/git.mjs';
import { release } from '../board/claims.mjs';
import { listRequests, postRequest, newRequestId, fenced } from '../board/requests.mjs';
import { readWorker, workerYaml, workerState } from '../board/registry.mjs';
import { parseLog } from '../board/events.mjs';
import { loadEfforts } from '../board/queue.mjs';
import { loadConfig } from '../board/config.mjs';
import { safeExcerpt } from '../board/redact.mjs';
import { WORKER_ID_RE } from '../board/safe-path.mjs';
import { isProtected } from '../../clean-env.mjs';
import { resolveRepoKeys } from '../../assemble-env.mjs';
import {
  sdlcHome, workerHome, readConfig, writeConfig, readState, writeState, readPid, writePid, clearPid, isAlive,
} from './home.mjs';
import { preflight } from './preflight.mjs';
import { makeContext, step, WorkerFatal } from './loop.mjs';
import { WORKER_PROCESS_VARS } from './agent.mjs';
import { letGo } from './outcomes.mjs';
import { pushCodeBranches } from './code-repos.mjs';
import { createWorker, CreateError } from './create.mjs';

class UsageError extends Error {}
class Refusal extends Error {}

const STOP_TIMEOUT_MS = 60_000;
const STOP_POLL_MS = 250;
const DEFAULT_IDLE_MS = 60_000;
const [DETACHED, PARENT_PID] = WORKER_PROCESS_VARS;

const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const firstLine = (e) => String(e?.message ?? e).split('\n')[0];

const USAGE = `usage: sdlc worker <command>
  create --agent claude|copilot --model <m> [--name <n>] [--meta <url>] [--no-probe]
  start <id> [--detach] | once <id> | stop <id>
  status <id> [--json] | list [--json]
  retire <id> [--force] | config <id> --model <m>
`;

// name -> { flags: { --flag: 'bool' | 'value' }, positional: n }
const COMMANDS = {
  create: { flags: { '--agent': 'value', '--model': 'value', '--name': 'value', '--meta': 'value', '--no-probe': 'bool' }, positional: 0 },
  start: { flags: { '--detach': 'bool' }, positional: 1 },
  once: { flags: {}, positional: 1 },
  stop: { flags: {}, positional: 1 },
  status: { flags: { '--json': 'bool' }, positional: 1 },
  list: { flags: { '--json': 'bool' }, positional: 0 },
  retire: { flags: { '--force': 'bool' }, positional: 1 },
  config: { flags: { '--model': 'value' }, positional: 1 },
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

// ---- deps ----------------------------------------------------------------------------------------

function processSignals(handler) {
  const on = (sig) => handler(sig);
  process.on('SIGTERM', on);
  process.on('SIGINT', on);
  return () => { process.off('SIGTERM', on); process.off('SIGINT', on); };
}

// Resolves after `ms`, or at once when `signal` aborts.
function abortableWait(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const done = () => { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); };
    const t = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

// The full command line of process `pid`; null when there is no such process; undefined when it cannot be
// told (ps missing or failing otherwise). Unknown never counts as "not ours" (Ruling P2-17).
export function realProcCommand(pid) {
  try {
    return execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() || null;
  } catch (e) {
    const quiet = !String(e.stdout ?? '').trim() && !String(e.stderr ?? '').trim();
    return e.status === 1 && quiet ? null : undefined; // ps exits 1, silently, for a pid it does not find
  }
}

const realGh = {
  api: (path) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })),
};

function resolveDeps(d) {
  return {
    out: d.out, err: d.err,
    env: d.env ?? process.env,
    cwd: d.cwd ?? process.cwd(),
    now: d.now ?? (() => new Date()),
    loop: d.loop ?? {}, // overrides for the loop context's deps (runAgent, gh, which, log, hooks, ...)
    onSignal: d.onSignal ?? processSignals,
    wait: d.wait ?? abortableWait,
    kill: d.kill ?? ((pid, sig) => process.kill(pid, sig)),
    isAlive: d.isAlive ?? isAlive,
    procCommand: d.procCommand ?? realProcCommand,
    spawn: d.spawn ?? realSpawn,
    pid: d.pid ?? process.pid,
    scriptPath: d.scriptPath, // the sdlc entry a detached worker runs; <home>/meta/scripts/sdlc.mjs by default
    gh: d.gh ?? realGh,
    stopTimeoutMs: d.stopTimeoutMs ?? STOP_TIMEOUT_MS,
  };
}

// The runtime log: stdout, plus logs/worker.log when stdout is not already that file (a foreground run).
function runtimeLog(home, d) {
  const file = join(home, 'logs', 'worker.log');
  const tee = d.env[DETACHED] !== '1';
  return (m) => {
    const line = `${iso(d.now())} ${m}\n`;
    d.out(line);
    if (!tee) return;
    try { mkdirSync(join(home, 'logs'), { recursive: true }); appendFileSync(file, line); } catch { /* best effort */ }
  };
}

// A pid file outlives reboots and pids get reused: a pid is this worker only while that process is alive and
// its command line is `… worker start|once <id>`. -> 'ours' | 'not' | 'unknown' (ps could not tell)
function workerStatus(pid, id, d) {
  if (!pid || !d.isAlive(pid)) return 'not';
  const cmd = d.procCommand(pid);
  if (cmd === undefined) return 'unknown';
  return cmd && new RegExp(`(^|\\s)worker\\s(.*\\s)?(start|once)\\s(.*\\s)?${id}(\\s|$)`).test(cmd) ? 'ours' : 'not';
}

const cannotTell = (id, pid, home) => new Refusal(`cannot tell whether pid ${pid} is worker ${id} (ps failed); `
  + `if it is not running, remove ${join(home, 'worker.pid')} and try again`);

// The pid of this worker's running process, or null. Throws when it cannot be told.
function runningPid(home, id, d) {
  const pid = readPid(home);
  const st = workerStatus(pid, id, d);
  if (st === 'unknown') throw cannotTell(id, pid, home);
  return st === 'ours' ? pid : null;
}

// The agent a worker left running, verified by its command line: a pid file can name a reused pid.
function leftoverAgent(home, cfg, d) {
  const file = join(home, 'run', 'agent.pid');
  let pid;
  try { pid = Number.parseInt(readFileSync(file, 'utf8'), 10); } catch { return null; }
  if (!(pid > 0) || !d.isAlive(pid)) return null;
  const want = basename(cfg.agent_cmd ?? cfg.agent);
  const cmd = d.procCommand(pid);
  return cmd && cmd.split(/\s+/).some((tok) => basename(tok) === want) ? pid : null;
}

// Kill a verified leftover agent's process group (never a bare pid), then forget the agent pid file.
function killLeftoverAgent(home, cfg, d, log) {
  const pid = leftoverAgent(home, cfg, d);
  if (pid) {
    try { d.kill(-pid, 'SIGKILL'); log(`killed the agent left running (process group ${pid})`); } catch { /* gone */ }
  }
  rmSync(join(home, 'run', 'agent.pid'), { force: true });
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const readText = (file) => { try { return readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

const LOCK_TRIES = 100;
const LOCK_WAIT_MS = 20;
const MARKER_ABANDONED_MS = 10_000; // a takeover takes milliseconds; an older marker is from a start that died

function clearAbandonedMarker(marker) {
  try {
    if (Date.now() - statSync(marker).mtimeMs > MARKER_ABANDONED_MS) rmSync(marker, { force: true });
  } catch { /* gone */ }
}

// The pid file is the run lock: created exclusively, so two starts can never both pass the check. A stale
// lock is taken over atomically (Ruling P2-17) under an exclusive takeover marker. An empty file is a lock
// being written, never stale. A detached worker takes over the lock its parent took for it.
// -> { stalePid } (the pid a stale lock named, 0 when it named none; null when there was none)
export function lockRun(home, id, d) {
  const file = join(home, 'worker.pid');
  const handedOver = d.env[DETACHED] === '1' ? [d.pid, Number(d.env[PARENT_PID]) || 0] : [];
  let stalePid = null;
  for (let attempt = 0; attempt < LOCK_TRIES; attempt++) {
    try {
      writeFileSync(file, `${d.pid}\n`, { flag: 'wx' });
      return { stalePid };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const text = readText(file);
    if (text === null) continue; // released or taken over meanwhile
    if (text.trim() === '') { sleepSync(LOCK_WAIT_MS); continue; } // another start is writing its pid
    const n = Number.parseInt(text.trim(), 10);
    const pid = n > 0 ? n : null;
    if (pid && handedOver.includes(pid)) { writePid(home, d.pid); return { stalePid }; }
    const st = workerStatus(pid, id, d);
    if (st === 'ours') throw new Refusal(`worker ${id} is already running, pid ${pid}`);
    if (st === 'unknown') throw cannotTell(id, pid, home);
    // Take over the stale lock: only the holder of its takeover marker may remove it, and only while the
    // lock still holds the content judged stale. No one else ever removes a lock, so a fresh one is safe.
    const marker = `${file}.takeover-${pid ?? 'none'}`;
    try {
      writeFileSync(marker, `${d.pid}\n`, { flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      clearAbandonedMarker(marker);
      sleepSync(LOCK_WAIT_MS); // another start is taking it over
      continue;
    }
    try {
      if (readText(file) === text) {
        rmSync(file, { force: true });
        stalePid ??= pid ?? 0;
      }
    } finally {
      rmSync(marker, { force: true });
    }
  }
  throw new Refusal(`worker ${id} is being started by another process`);
}

function requireHome(id, d) {
  if (!WORKER_ID_RE.test(String(id))) throw new UsageError(`invalid worker id "${id}"`);
  const home = workerHome(id, d.env);
  if (!existsSync(join(home, 'config.json'))) throw new Refusal(`no worker ${id} on this machine (${home})`);
  return home;
}

const context = (home, d, signal) => {
  const base = { now: d.now };
  if (!d.loop.log) base.log = runtimeLog(home, d);
  return makeContext({ home, deps: { ...base, ...d.loop }, signal });
};

// fn(dir) over a throwaway copy of the clone's origin/main docs/ and board/ (no fetch).
function onMain(clone, fn) {
  const snap = snapshotMain(clone);
  try { return fn(snap.dir); } finally { snap.cleanup(); }
}

function refresh(ctx) {
  try { fetchMain(ctx.clone, identityEnv(ctx.identity)); return true; } catch (e) {
    ctx.deps.log(`warning: cannot reach origin (${firstLine(e)}); using the last fetched main`);
    return false;
  }
}

// ---- protocol writes ------------------------------------------------------------------------------

// start / stop / crash: an empty event commit (Plan 1's event kinds that need no file change).
function event(ctx, kind, body) {
  const { cfg, clone, identity, deps } = ctx;
  return boardWrite(clone, {
    kind, subject: cfg.id, body, identity, trailers: { worker: cfg.id }, onReject: 'rebase', commitFromHead: true,
    hooks: deps.hooks, sleep: deps.sleep, mutate: () => {},
  });
}

async function tryEvent(ctx, kind, body) {
  try {
    const r = await event(ctx, kind, body);
    if (!r.ok) ctx.deps.log(`warning: could not push the ${kind} event (${r.reason})`);
    return r.ok;
  } catch (e) {
    ctx.deps.log(`warning: could not push the ${kind} event (${firstLine(e)})`);
    return false;
  }
}

// One write to this worker's registry file. patch(entry) -> the new entry, or null when nothing changes.
async function updateRegistry(ctx, kind, patch, check) {
  const { cfg, clone, identity, deps } = ctx;
  const file = `board/workers/${cfg.id}.yml`;
  let missing = false;
  const r = await boardWrite(clone, {
    kind, subject: cfg.id, identity, trailers: { worker: cfg.id }, onReject: 'rebase', commitFromHead: true,
    hooks: deps.hooks, sleep: deps.sleep,
    mutate: (tree) => {
      const text = tree.read(file);
      const w = text === null ? null : parse(text);
      if (!w || typeof w !== 'object') { missing = true; return; }
      const next = patch(w);
      if (next) tree.write(file, workerYaml(next));
    },
    validate: (view) => { const t = view.read(file); return t !== null && check(parse(t)); },
  });
  if (missing) throw new Refusal(`worker ${cfg.id} is not registered on the board`);
  if (r.ok || r.reason === 'nothing-to-do') return;
  throw new Refusal(`could not update board/workers/${cfg.id}.yml (${r.reason})`);
}

// Release every claim this worker holds on origin/main, pushing each effort's code branches first.
// -> { held: [slug], ok: every release landed }
async function releaseHeld(ctx) {
  const { cfg, clone, identity, deps } = ctx;
  let ok = true;
  const held = onMain(clone, (board) => loadEfforts(board).efforts.filter((e) => e.fm?.claimed_by === cfg.id).map((e) => e.slug));
  for (const slug of held) {
    const code = pushCodeBranches(clone, slug, resolveRepoKeys(clone, slug));
    for (const f of code.failed) deps.log(`warning: push of workspace/${f.key} failed: ${f.error}; the commits stay in the local branch`);
    const r = await release(clone, slug, { claimant: cfg.id, identity, workerId: cfg.id, hooks: deps.hooks });
    deps.log(r.ok ? `released ${slug}` : `could not release ${slug} (${r.reason})`);
    ok &&= r.ok;
  }
  if (held.length) writeState(ctx.home, { prepared: null });
  return { held, ok };
}

// The previous run ended without a clean stop: a crash event, then a worker error (one open per worker).
async function reportCrash(ctx, why) {
  const { cfg, home, clone, identity, deps } = ctx;
  deps.log(`worker ${cfg.id} stopped without a clean shutdown: ${why}`);
  await tryEvent(ctx, 'crash', why);
  const open = onMain(clone, (board) => listRequests(board).requests.some((r) => r.fm.kind === 'error'
    && r.fm.scope === 'worker' && r.fm.worker === cfg.id && r.fm.status === 'open'));
  if (open) { deps.log('a worker error is already open; not posting another'); return; }
  const logFile = join(home, 'logs', 'worker.log');
  const tail = existsSync(logFile) ? readFileSync(logFile, 'utf8').replace(/\n+$/, '') : '';
  const excerpt = tail ? safeExcerpt(tail, { maxLines: 50 }).text : '(logs/worker.log is empty)';
  const now = deps.now();
  try {
    const r = await postRequest(clone, {
      id: newRequestId(now, deps.rand), kind: 'error', scope: 'worker', worker: cfg.id, for: cfg.owner, blocking: true, now,
      sections: {
        Request: `worker ${cfg.id} stopped without a clean shutdown. Check the log below and the machine it runs on, then answer resolved.`,
        Context: `Host ${hostname()}: ${why}. Last lines of logs/worker.log:\n\n${fenced(excerpt)}`,
        Error: why,
      },
    }, { identity, workerId: cfg.id, sleep: deps.sleep, hooks: deps.hooks });
    deps.log(r.ok ? `worker error ${r.id} posted for the crash` : `could not post the crash worker error (${r.reason})`);
  } catch (e) {
    deps.log(`could not post the crash worker error (${firstLine(e)})`);
  }
}

// ---- process control ------------------------------------------------------------------------------

// SIGKILL the worker's process group (a detached worker leads its own), or the worker alone when it leads
// none (a worker started in a terminal). Only for a pid verified as this worker.
function killGroup(pid, d) {
  try { d.kill(-pid, 'SIGKILL'); } catch {
    try { d.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
}

// SIGTERM, wait up to stopTimeoutMs, then SIGKILL the worker's group and the agent's group it left behind.
// -> true when it had to kill. Throws when the worker cannot be signalled or survives the kill.
async function endProcess(home, pid, d) {
  try { d.kill(pid, 'SIGTERM'); } catch (e) {
    if (e.code === 'ESRCH') return false;
    throw new Refusal(`cannot signal pid ${pid}: ${e.code ?? firstLine(e)}`);
  }
  for (let waited = 0; waited < d.stopTimeoutMs; waited += STOP_POLL_MS) {
    if (!d.isAlive(pid)) return false;
    await d.wait(STOP_POLL_MS);
  }
  if (!d.isAlive(pid)) return false;
  killGroup(pid, d);
  killLeftoverAgent(home, readConfig(home), d, () => {});
  for (let i = 0; i < 40 && d.isAlive(pid); i++) await d.wait(STOP_POLL_MS);
  if (d.isAlive(pid)) {
    throw new Refusal(`worker pid ${pid} is still alive after SIGKILL; nothing was released (run stop again once it is gone)`);
  }
  return true;
}

// The worker was killed before its own shutdown ran: release and the stop event from <home>/meta. The stop
// counts as clean only when both landed (Ruling P2-16); otherwise the next start reports a crash.
async function cleanUpAfterKill(home, d) {
  const ctx = context(home, d);
  ctx.deps.log(`worker ${ctx.cfg.id} did not stop within ${d.stopTimeoutMs / 1000}s; killed`);
  refresh(ctx);
  let released = false;
  try { released = (await releaseHeld(ctx)).ok; } catch (e) { ctx.deps.log(`warning: could not release claims (${firstLine(e)})`); }
  const stopped = await tryEvent(ctx, 'stop', 'killed after it did not stop in time');
  writeState(home, { clean_stop: released && stopped });
  clearPid(home);
}

async function stopRunning(id, home, d) {
  const pid = runningPid(home, id, d);
  if (!pid) return false;
  if (await endProcess(home, pid, d)) await cleanUpAfterKill(home, d);
  return true;
}

// ---- commands -----------------------------------------------------------------------------------

async function cmdCreate({ flags }, d) {
  const agent = flags['--agent'];
  const model = flags['--model'];
  if (!agent || !model) throw new UsageError('create needs --agent and --model');
  let metaUrl = flags['--meta'];
  if (!metaUrl) {
    try {
      metaUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: d.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch { throw new Refusal(`no --meta given and ${d.cwd} has no origin remote`); }
  }
  try {
    const { id, home } = await createWorker({
      metaUrl, agent, model, name: flags['--name'], probe: !flags['--no-probe'], gh: d.gh, env: d.env, now: d.now,
    });
    d.out(`created worker ${id}\n  home: ${home}\n  start it with: sdlc worker start ${id}\n`);
    return 0;
  } catch (e) {
    if (e instanceof CreateError) throw new Refusal(e.message);
    throw e;
  }
}

// Holds the run lock (lockRun) and hands it to the child: the child takes over a lock naming it or us.
function detach(id, home, d, stalePid) {
  const logFile = join(home, 'logs', 'worker.log');
  let child;
  try {
    // A stale pid file was just replaced: keep its crash signal for the worker's own start.
    if (stalePid !== null) writeState(home, { clean_stop: false });
    const script = d.scriptPath ?? join(home, 'meta', 'scripts', 'sdlc.mjs');
    if (!existsSync(script)) throw new Refusal(`cannot start in the background: ${script} is missing (is the kit installed in the meta repo?)`);
    mkdirSync(join(home, 'logs'), { recursive: true });
    const fd = openSync(logFile, 'a');
    try {
      child = d.spawn(process.execPath, [script, 'worker', 'start', id], {
        cwd: join(home, 'meta'), detached: true, stdio: ['ignore', fd, fd],
        env: { ...d.env, [DETACHED]: '1', [PARENT_PID]: String(d.pid) },
      });
    } finally { closeSync(fd); }
    if (!child.pid) throw new Refusal('could not start the background worker');
  } catch (e) {
    clearPid(home);
    throw e;
  }
  child.unref();
  if (readPid(home) === d.pid) writePid(home, child.pid);
  d.out(`worker ${id} started in the background, pid ${child.pid}; log: ${logFile}\n`);
  return 0;
}

// start and once: preflight, crash detection, the start event, the loop (or one cycle), the shutdown.
async function cmdRun({ flags, positional: [id] }, d, { once }) {
  const home = requireHome(id, d);
  const { stalePid } = lockRun(home, id, d);
  if (flags['--detach']) return detach(id, home, d, stalePid);

  const ac = new AbortController();
  let ctx;
  try {
    ctx = context(home, d, ac.signal);
    // A previous run's agent pid file: kill that agent if it still runs (verified), then forget it.
    killLeftoverAgent(home, ctx.cfg, d, ctx.deps.log);
    refresh(ctx);
    const pf = onMain(ctx.clone, (board) => preflight({ home, cfg: ctx.cfg, root: board, gh: { authOk: () => true }, which: () => true }));
    // only fatal problems are checked here; the loop's own preflight handles the rest
    if (!pf.ok) throw new Refusal(pf.problem);
  } catch (e) {
    clearPid(home); // a refused start leaves nothing behind
    throw e;
  }
  const { cfg, clone, deps } = ctx;
  const crashed = stalePid !== null ? `its pid file names process ${stalePid}, which is not this worker running`
    : readState(home).clean_stop === false ? 'its last run did not record a clean stop' : null;

  let stopping = null;
  const off = d.onSignal((sig) => {
    if (stopping) return;
    stopping = sig;
    deps.log(`${sig}: stopping`);
    ac.abort();
  });
  writeState(home, { clean_stop: false });
  let code = 0;
  let canWrite = true;
  try {
    if (crashed) await reportCrash(ctx, crashed);
    await tryEvent(ctx, 'start');
    deps.log(`worker ${id} started (pid ${d.pid}, ${cfg.agent} ${cfg.model})`);
    code = once ? await oneCycle(ctx, d) : await loop(ctx, d, ac.signal);
  } catch (e) {
    if (!(e instanceof WorkerFatal)) throw e;
    d.err(`${e.message}\n`);
    deps.log(`stopping: ${e.message}`);
    code = 1;
    // A retired or unregistered worker writes nothing more (not even its stop event).
    canWrite = onMain(clone, (board) => { const w = readWorker(board, id); return !!w && !w.retired_at; });
  } finally {
    off();
    if (canWrite && ctx.holding) {
      const slug = ctx.holding.slug;
      try { await letGo(ctx, slug, resolveRepoKeys(clone, slug)); } catch (e) { deps.log(`warning: could not release ${slug} (${firstLine(e)})`); }
    }
    if (canWrite) await tryEvent(ctx, 'stop', stopping ? `stopped by ${stopping}` : undefined);
    writeState(home, { clean_stop: true });
    if (readPid(home) === d.pid) clearPid(home);
    deps.log(`worker ${id} stopped`);
  }
  return code;
}

async function loop(ctx, d, signal) {
  while (!signal.aborted) {
    let r;
    try {
      r = await step(ctx);
    } catch (e) {
      if (e instanceof WorkerFatal) throw e;
      ctx.deps.log(`step failed: ${firstLine(e)}; staying idle`);
      r = { action: 'idle' };
    }
    if (signal.aborted) break;
    if (r.action === 'idle' || r.action === 'needs-attention') await d.wait(ctx.board?.idlePollMs ?? DEFAULT_IDLE_MS, signal);
  }
  return 0;
}

// One step: claim, one phase, report. The caller's shutdown releases whatever is still held.
async function oneCycle(ctx, d) {
  const r = await step(ctx);
  if (r.action === 'needs-attention') { d.err(`worker ${ctx.cfg.id} needs attention: see sdlc inbox\n`); return 1; }
  if (r.action === 'idle' && !ctx.holding) {
    const until = readState(ctx.home).backoff_until;
    d.out(until && ctx.deps.now() < new Date(until) ? `backing off until ${until}\n` : 'queue empty\n');
    return 0;
  }
  d.out(`${r.action}${r.effort ? ` ${r.effort}` : ''}\n`);
  return r.action === 'failed' ? 1 : 0;
}

async function cmdStop({ positional: [id] }, d) {
  const home = requireHome(id, d);
  if (!(await stopRunning(id, home, d))) { d.out(`worker ${id} is not running\n`); return 0; }
  d.out(`worker ${id} stopped\n`);
  return 0;
}

function localIds(d) {
  const dir = join(sdlcHome(d.env), 'workers');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => WORKER_ID_RE.test(n) && existsSync(join(dir, n, 'config.json'))).sort();
}

// A local home joined with the worker's state derived from its meta clone's origin/main.
function describe(id, d) {
  const home = workerHome(id, d.env);
  const cfg = readConfig(home);
  let pid = null;
  let running;
  try { pid = runningPid(home, id, d); running = !!pid; } catch { running = 'unknown'; }
  const clone = join(home, 'meta');
  let board = { state: 'unknown', effort: null, lastSeen: null };
  try { fetchMain(clone); } catch (e) { d.err(`warning: ${id}: could not refresh from origin/main: ${firstLine(e)}\n`); }
  try {
    board = onMain(clone, (root) => {
      const { leaseTtlMs } = loadConfig(root);
      return workerState(id, {
        worker: readWorker(root, id), events: parseLog(clone, { ref: 'origin/main' }), efforts: loadEfforts(root).efforts,
        requests: listRequests(root).requests, now: d.now(), ttlMs: leaseTtlMs,
      });
    });
  } catch (e) { d.err(`warning: ${id}: could not read the board: ${firstLine(e)}\n`); }
  return {
    id, name: cfg.name, agent: cfg.agent, model: cfg.model, home, running, pid: running ? pid : null,
    state: board.state, effort: board.effort, lastSeen: board.lastSeen,
  };
}

const table = (head, rows) => {
  const all = [head, ...rows];
  const w = head.map((_, i) => Math.max(...all.map((r) => String(r[i] ?? '').length)));
  return all.map((r) => r.map((c, i) => String(c ?? '').padEnd(w[i])).join('  ').trimEnd()).join('\n');
};

function render(rows, json, d) {
  if (json) { d.out(`${JSON.stringify(rows)}\n`); return; }
  const ts = (v) => (v ? new Date(v).toISOString().slice(0, 16).replace('T', ' ') : '-');
  d.out(`${table(['id', 'name', 'model', 'local', 'state', 'effort', 'last seen'], rows.map((w) => [
    w.id, w.name, `${w.agent}/${w.model}`, w.running === 'unknown' ? 'unknown (ps failed)' : w.running ? `running (pid ${w.pid})` : 'stopped', w.state, w.effort ?? '-', ts(w.lastSeen),
  ]))}\n`);
}

function cmdStatus({ flags, positional: [id] }, d) {
  requireHome(id, d);
  const row = describe(id, d);
  render(flags['--json'] ? row : [row], flags['--json'], d);
  return 0;
}

function cmdList({ flags }, d) {
  const ids = localIds(d);
  if (!ids.length && !flags['--json']) { d.out('no workers on this machine\n'); return 0; }
  render(ids.map((id) => describe(id, d)), flags['--json'], d);
  return 0;
}

async function cmdRetire({ flags, positional: [id] }, d) {
  const home = requireHome(id, d);
  if (await stopRunning(id, home, d)) d.out(`stopped worker ${id}\n`);
  const ctx = context(home, d);
  const { clone } = ctx;
  refresh(ctx);
  const { held, ok } = await releaseHeld(ctx);
  for (const slug of held) d.out(`released ${slug}\n`);
  if (!ok) throw new Refusal(`worker ${id} not retired: a claim could not be released (see the log)`);
  const ws = join(clone, 'workspace');
  const keep = [
    ...(isProtected(clone) ? ['meta'] : []),
    ...(existsSync(ws) ? readdirSync(ws).filter((k) => !k.startsWith('.') && isProtected(join(ws, k))).map((k) => `meta/workspace/${k}`) : []),
    ...(existsSync(join(home, 'salvage')) && readdirSync(join(home, 'salvage')).length ? ['salvage'] : []),
  ];
  if (keep.length && !flags['--force']) {
    throw new Refusal(`worker ${id} not retired: unpushed or uncommitted work in ${keep.join(', ')} under ${home}; `
      + 'push or copy it, or run retire again with --force to delete it');
  }
  const stamp = iso(d.now());
  await updateRegistry(ctx, 'retire', (w) => (w.retired_at ? null : { ...w, retired_at: stamp }), (w) => !!w?.retired_at);
  rmSync(home, { recursive: true, force: true });
  d.out(`worker ${id} retired; deleted ${home}\n`);
  return 0;
}

async function cmdConfig({ flags, positional: [id] }, d) {
  const model = flags['--model'];
  if (!model) throw new UsageError('config needs --model');
  const home = requireHome(id, d);
  const pid = runningPid(home, id, d);
  if (pid) throw new Refusal(`worker ${id} is running (pid ${pid}); stop it first`);
  const ctx = context(home, d);
  refresh(ctx);
  await updateRegistry(ctx, 'config', (w) => (w.model === model ? null : { ...w, model }), (w) => w?.model === model);
  writeConfig(home, { ...readConfig(home), model });
  d.out(`worker ${id} now runs ${model}\n`);
  return 0;
}

const HANDLERS = {
  create: cmdCreate,
  start: (a, d) => cmdRun(a, d, { once: false }),
  once: (a, d) => cmdRun(a, d, { once: true }),
  stop: cmdStop, status: cmdStatus, list: cmdList, retire: cmdRetire, config: cmdConfig,
};

export async function runWorker(argv, deps) {
  const d = resolveDeps(deps);
  const [cmd, ...rest] = argv;
  try {
    if (!cmd || !COMMANDS[cmd]) throw new UsageError(cmd ? `unknown worker command ${cmd}` : 'missing worker command');
    const args = parseArgs(COMMANDS[cmd], rest);
    if (args.positional.length && !WORKER_ID_RE.test(args.positional[0])) throw new UsageError(`invalid worker id "${args.positional[0]}"`);
    return await HANDLERS[cmd](args, d);
  } catch (e) {
    if (e instanceof UsageError) { d.err(`${e.message}\n${USAGE}`); return 2; }
    d.err(`${firstLine(e)}\n`);
    return 1;
  }
}

export const run = runWorker;
