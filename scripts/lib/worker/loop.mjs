// The worker loop step: one iteration of docs/design/workers.md "The worker loop". A step holds at most one
// effort; between steps that is ctx.holding (memory) plus <home>/run/agent-input/<slug>.json (Ruling P2-3).
// What follows the agent run (report, request, errors) is in outcomes.mjs.
import { join, dirname } from 'node:path';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fetchMain, snapshotMain, boardWrite, identityEnv, BoardError } from '../board/git.mjs';
import { claim, renew, holds, committedFm, claimState } from '../board/claims.mjs';
import { loadEfforts, rank, overlaps } from '../board/queue.mjs';
import { listRequests } from '../board/requests.mjs';
import { applyAnswered, applyClosed } from '../board/effects.mjs';
import { loadConfig } from '../board/config.mjs';
import { syncKeepingWork, SyncConflict } from '../board/report.mjs';
import { loadCatalog } from '../catalog.mjs';
import { assemble as realAssemble, resolveRepoKeys } from '../../assemble-env.mjs';
import { readConfig, readState, writeState, excludeRunDir } from './home.mjs';
import {
  route, buildPrompt, agentCommand, runAgent as realRunAgent, RUN_DIR, runDirProblem, planDone, phaseOf,
} from './agent.mjs';
import { preflight, realDeps as preflightDeps } from './preflight.mjs';
import { lose, letGo, effortError, workerError, handleResult, interrupted } from './outcomes.mjs';
import { readSaved, writeInput, clearInput, savedSlugs } from './agent-input.mjs';
import { salvage } from './salvage.mjs';
import { prepareCheckouts } from './code-repos.mjs';

// A problem the worker must not write past (unregistered, retired, config/registry mismatch): stop.
export class WorkerFatal extends Error {}

const CANDIDATE = new Set(['ACCEPTED', 'DESIGNED', 'PLANNED', 'IN_PROGRESS']);
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const firstLine = (e) => String(e?.message ?? e).split('\n')[0];
export const BOARD_ERROR_LIMIT = 3; // board failures in a row on a held effort before an effort error
// `continued`: this hold carries on a claim whose checkouts this worker already prepared, so local code
// commits ahead of origin are ours to keep (Rulings P2-13, P2-14). `prepared`: prepareCheckouts has run in
// this hold. A new claim, a takeover, or a claim that never got as far as preparing is not a continuation.
// `pending`: a finished run whose result is not handled yet ({ status, res, keys, logPath }); the next step
// handles it again instead of running the agent again.
// `phase`: the phase this hold's last run was routed to (recorded in the requests it posts).
const held = (slug, continued) => ({ slug, continued, prepared: false, phase: null, stalls: 0, boardErrors: 0, pending: null });

// Ruling P2-14: continuation is proven by state.json's `prepared` marker, written only after
// prepareCheckouts ran for a claim. renew keeps claimed_at; a new claim or a takeover changes it, so a claim
// pushed just before a crash (never prepared) does not match.
export function continuesOurClaim(clone, slug, { claimant, prepared, now, ttlMs }) {
  const fm = committedFm(clone, slug, 'origin/main');
  return !!fm && fm.claimed_by === claimant && claimState(fm, now, ttlMs) === 'live'
    && prepared?.slug === slug && !!fm.claimed_at && String(prepared.claimed_at) === String(fm.claimed_at);
}

// `signal` (AbortSignal, optional): aborting it stops a running agent; the step then ends with the
// interrupted outcome (code pushed, changed docs reported, claim released).
export function makeContext({ home, deps = {}, signal }) {
  const cfg = readConfig(home);
  const pf = preflightDeps();
  return {
    home, cfg, clone: join(home, 'meta'), holding: null, signal,
    identity: { name: cfg.author.name, email: cfg.author.email },
    deps: {
      now: () => new Date(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      gh: pf.gh, which: pf.which, runAgent: realRunAgent, assemble: realAssemble, rand: Math.random, hooks: undefined,
      log: (m) => process.stdout.write(`${iso(new Date())} ${m}\n`),
      ...deps,
    },
  };
}

// Every board write refuses while local main is ahead of origin/main, so a commit in the meta clone (an agent
// that commits a doc, a report commit whose push a kill cut off) would stop the worker for good. The worker
// turns such commits back into uncommitted edits (reset --mixed to the merge base), which the normal report and
// salvage paths then handle. The interactive boardWrite keeps refusing. -> true when it unwound something
export function unwindLocalCommits(ctx) {
  const g = (args) => execFileSync('git', args, { cwd: ctx.clone, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let ahead;
  try { ahead = g(['rev-list', '--count', 'origin/main..HEAD']); } catch { return false; }
  if (ahead === '0') return false;
  try {
    const commits = g(['log', '--format=%h %s', 'origin/main..HEAD']).split('\n').join('; ');
    g(['reset', '-q', '--mixed', g(['merge-base', 'HEAD', 'origin/main'])]);
    ctx.deps.log(`unwound ${ahead} local meta commit(s) not on origin/main (${commits}); their changes are uncommitted edits now`);
    return true;
  } catch (e) {
    ctx.deps.log(`warning: could not unwind the local meta commits: ${firstLine(e)}`);
    return false;
  }
}

// Every board write refuses off main, so an agent (or a person) that left the meta clone on another branch or a
// detached HEAD would stop the worker for good. The worker moves the dirty files aside (Ruling P2-11) and checks
// main out again. Commits made off main are listed in the log and stay reachable in this private clone: on their
// branch, or (detached HEAD) on a new sdlc-salvage/<stamp> branch. -> true when it restored main
export function restoreMain(ctx) {
  const g = (args) => execFileSync('git', args, { cwd: ctx.clone, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let branch = null;
  try {
    branch = g(['symbolic-ref', '-q', '--short', 'HEAD']);
    if (branch === 'main') return false;
  } catch { /* detached HEAD: symbolic-ref fails */ }
  const where = branch ? `branch ${branch}` : 'a detached HEAD';
  try {
    salvage(ctx, { code: false, reason: `meta was left on ${where}` });
    const commits = g(['log', '--format=%h %s', 'main..HEAD']).split('\n').filter(Boolean);
    let kept = branch;
    if (commits.length && !branch) {
      const stamp = iso(ctx.deps.now()).replace(/[-:]/g, '');
      kept = `sdlc-salvage/${stamp}`;
      for (let n = 2; g(['branch', '--list', kept]); n++) kept = `sdlc-salvage/${stamp}-${n}`;
      g(['branch', kept, 'HEAD']);
    }
    g(['checkout', '-q', 'main']);
    const note = commits.length ? `; its ${commits.length} commit(s) off main stay on branch ${kept}: ${commits.join('; ')}` : '';
    ctx.deps.log(`meta was on ${where}; checked out main again${note}`);
    return true;
  } catch (e) {
    ctx.deps.log(`warning: could not check out main in meta (it is on ${where}): ${firstLine(e)}`);
    return false;
  }
}

// ---- the step ---------------------------------------------------------------------------------

export async function step(ctx) {
  try {
    fetchMain(ctx.clone, identityEnv(ctx.identity));
  } catch (e) {
    ctx.deps.log(`cannot reach origin: ${firstLine(e)}; staying idle`);
    return { action: 'idle' };
  }
  restoreMain(ctx);
  unwindLocalCommits(ctx);
  const snap = snapshotMain(ctx.clone);
  try {
    const r = await stepOn(ctx, snap.dir);
    if (ctx.holding) ctx.holding.boardErrors = 0;
    return r;
  } catch (e) {
    // Any failure while holding counts (a finished run's result stays pending, so a retry never re-runs the
    // agent); without a hold only a board failure is expected here.
    if (e instanceof WorkerFatal || (!(e instanceof BoardError) && !ctx.holding)) throw e;
    ctx.deps.log(`${e instanceof BoardError ? 'board write failed' : 'step failed'}: ${firstLine(e)}; staying idle`);
    const h = ctx.holding;
    if (h && ++h.boardErrors >= BOARD_ERROR_LIMIT && ctx.board) {
      // The lease would rot while we idle: hand the effort to a person instead.
      const status = committedFm(ctx.clone, h.slug, 'origin/main')?.status ?? 'unknown';
      try {
        return await effortError(ctx, h.slug, status, `${BOARD_ERROR_LIMIT} steps in a row failed; last: ${firstLine(e)}`, { keys: h.pending?.keys ?? [], logPath: h.pending?.logPath });
      } catch (e2) {
        ctx.deps.log(`could not post the effort error for ${h.slug}: ${firstLine(e2)}`);
      }
    }
    return { action: 'idle' };
  } finally {
    snap.cleanup();
  }
}

async function stepOn(ctx, board) {
  const { cfg, deps, home, clone } = ctx;
  const bcfg = loadConfig(board);
  ctx.board = bcfg; // this step's board settings
  const pf = preflight({ home, cfg, root: board, gh: deps.gh, which: deps.which });
  if (!pf.ok && pf.kind === 'fatal') throw new WorkerFatal(pf.problem);
  if (!pf.ok) return workerError(ctx, pf.problem, pf.problem);
  const mine = listRequests(board).requests.filter((r) => r.fm.kind === 'error' && r.fm.scope === 'worker' && r.fm.worker === cfg.id);
  const open = mine.filter((r) => r.fm.status === 'open');
  if (open.length) {
    deps.log(`needs attention: worker error ${open.map((r) => r.id).join(', ')} is open`);
    return { action: 'needs-attention' };
  }
  const resolved = mine.filter((r) => r.fm.status === 'answered' && r.fm.answer === 'resolved');
  if (resolved.length) await clearResolved(ctx, resolved.map((r) => r.id));

  const now = deps.now();
  const resumable = savedSlugs(home).find((s) => holds(clone, s, cfg.id, { ref: 'origin/main' }));
  const continued = (s) => continuesOurClaim(clone, s, { claimant: cfg.id, prepared: readState(home).prepared, now, ttlMs: bcfg.leaseTtlMs });
  let slug = ctx.holding?.slug ?? null;
  if (slug) {
    if (!holds(clone, slug, cfg.id, { ref: 'origin/main' })) return lose(ctx, slug);
    if (ctx.holding.pending) {
      deps.log(`handling the finished run of ${slug} again (its result was not handled yet)`);
      return finishRun(ctx, slug, ctx.holding.pending, bcfg);
    }
  } else if (resumable) {
    slug = resumable;
    ctx.holding = held(slug, continued(slug));
    deps.log(`resuming ${slug} with its saved agent input`);
  } else {
    const { backoff_until: until } = readState(home);
    if (until && now < new Date(until)) {
      deps.log(`backing off until ${until}`);
      return { action: 'idle' };
    }
    const picked = await pickAndClaim(ctx, board, bcfg, now);
    if (!picked) {
      await applyOnClosed(ctx, now);
      return { action: 'idle' };
    }
    slug = picked.slug;
    ctx.holding = held(slug, continued(slug));
  }
  return runHeld(ctx, slug, bcfg, board);
}

// Ruling P2-4: the worker's own answered-resolved worker errors are deleted before it takes work again.
async function clearResolved(ctx, ids) {
  const { cfg, deps, clone, identity } = ctx;
  const r = await boardWrite(clone, {
    kind: 'apply', subject: 'worker', identity, onReject: 'restart', commitFromHead: true, hooks: deps.hooks,
    trailers: { worker: cfg.id },
    mutate: (tree) => {
      for (const q of listRequests(tree).requests) {
        if (ids.includes(q.id) && q.fm.status === 'answered' && q.fm.answer === 'resolved') tree.remove(q.path);
      }
    },
    validate: (view) => ids.every((id) => !view.exists(`board/requests/${id}.md`)),
  });
  deps.log(r.ok ? `cleared resolved worker error ${ids.join(', ')}` : `could not clear worker error ${ids.join(', ')} (${r.reason})`);
}

function readonlyKeys(clone) {
  try {
    return new Set(Object.entries(loadCatalog(clone).repos).filter(([, r]) => r.readonly).map(([k]) => k));
  } catch { return new Set(); }
}

// In-flight before new: our own live claims first, then the ranked queue. -> { slug } or null
async function pickAndClaim(ctx, board, bcfg, now) {
  const { cfg, deps, clone, identity } = ctx;
  const ttlMs = bcfg.leaseTtlMs;
  const { efforts } = loadEfforts(board);
  const openIds = new Set(listRequests(board).requests.filter((r) => r.fm.status === 'open').map((r) => r.id));
  const ours = efforts.filter((e) => CANDIDATE.has(e.status) && e.fm?.claimed_by === cfg.id && claimState(e.fm, now, ttlMs) === 'live');
  const ro = readonlyKeys(clone);
  let fetched = true; // step() fetched just now
  for (const e of [...ours, ...rank(efforts, { now, ttlMs, openRequestIds: openIds })]) {
    const warnings = overlaps(e, efforts, { now, ttlMs, readonlyKeys: ro })
      .map((o) => `${e.slug} shares ${o.repos.join(', ')} with ${o.slug}`);
    for (const w of warnings) deps.log(`warning: ${w}`);
    const r = await claim(clone, e.slug, {
      claimant: cfg.id, identity, workerId: cfg.id, now, ttlMs, hooks: deps.hooks, fetched,
      body: warnings.length ? `Overlap warning:\n${warnings.map((w) => `- ${w}`).join('\n')}` : undefined,
    });
    if (r.ok) {
      deps.log(r.takeover ? `took over ${e.slug} from ${r.takeover}` : r.renewed ? `continuing our claim on ${e.slug}` : `claimed ${e.slug}`);
      return { slug: e.slug };
    }
    deps.log(`could not claim ${e.slug} (${r.reason})`);
    fetched = false;
  }
  return null;
}

// Ruling P2-1: with nothing to claim, apply answered clarifications on IMPLEMENTED efforts.
async function applyOnClosed(ctx, now) {
  const { cfg, deps, clone, identity } = ctx;
  const r = await applyClosed(clone, { identity, workerId: cfg.id, now, rand: deps.rand, hooks: deps.hooks });
  if (r.applied.length) deps.log(`applied ${r.applied.join(', ')} on closed efforts`);
  for (const p of r.problems) deps.log(`warning: request ${p.id} not applied: ${p.problems.join('; ')}`);
  if (!r.ok) deps.log(`could not apply answers on closed efforts (${r.reason})`);
}

function runLogPath(home, now, slug, phase) {
  const base = join(home, 'logs', 'runs', `${iso(now).replace(/[-:]/g, '')}-${slug}-${phase}`);
  let p = `${base}.log`;
  for (let n = 2; existsSync(p); n++) p = `${base}-${n}.log`;
  return p;
}

// Answered requests on this effort (read before the apply commit deletes them): their ids, and the routed
// phase (develop|close-out) a worker recorded in their Context when it posted them.
function answeredOn(board, slug) {
  const qs = listRequests(board).requests.filter((q) => q.fm.status === 'answered' && q.fm.scope === 'effort' && q.fm.effort === slug);
  const phase = qs.map((q) => phaseOf(q.sections?.Context)).find(Boolean) ?? null;
  return { ids: qs.map((q) => q.id), phase };
}

async function runHeld(ctx, slug, bcfg, board) {
  const { cfg, deps, home, clone, identity } = ctx;
  const answered = answeredOn(board, slug);
  const a = await applyAnswered(clone, slug, { claimant: cfg.id, identity, workerId: cfg.id, now: deps.now(), rand: deps.rand, hooks: deps.hooks });
  if (!a.ok) {
    if (a.reason === 'replaced') return lose(ctx, slug);
    deps.log(`could not apply answers for ${slug} (${a.reason}); staying idle`);
    return { action: 'idle' };
  }
  for (const p of a.problems) deps.log(`warning: request ${p.id} not applied: ${p.problems.join('; ')}`);

  const fm = committedFm(clone, slug, 'origin/main');
  if (!fm || fm.claimed_by !== cfg.id) return lose(ctx, slug);
  // Saved input belongs to the hold that applied it: this claim, a continuation of it, or the effort error
  // whose answer was applied just now. Anything else is from an earlier hold and is dropped.
  const saved = readSaved(home, slug);
  const ours = ctx.holding.continued || (!!saved.claimed_at && String(saved.claimed_at) === String(fm.claimed_at))
    || (!!saved.after && answered.ids.includes(saved.after));
  if (saved.agentInput.length && !ours) deps.log(`dropped saved agent input for ${slug}: it belongs to an earlier hold`);
  const agentInput = [...(ours ? saved.agentInput : []), ...a.agentInput];
  const phase = (a.agentInput.length && answered.phase) || (ours && saved.phase) || null;
  if (agentInput.length) writeInput(home, slug, agentInput, { claimed_at: fm.claimed_at, phase });
  else clearInput(home, slug);
  // The agent works on what main says now (applied answers included). Leftovers that block the sync are
  // from earlier work this worker can no longer publish: move them aside (Ruling P2-11), never fail on them.
  const env = identityEnv(identity);
  try {
    syncKeepingWork(clone, env);
  } catch (e) {
    if (!(e instanceof SyncConflict)) throw e;
    salvage(ctx, { paths: e.paths, code: false, reason: `they block ${slug}'s sync with origin/main` });
    syncKeepingWork(clone, env);
  }
  // Development is done when the plan says so (durable); answers go back to the phase that asked for them.
  const developmentDone = fm.status === 'IN_PROGRESS' && (phase ? phase === 'close-out' : planDone(clone, slug, { log: deps.log }));
  const r = route(fm.status, { developmentDone });
  if (!r) { // an answer parked or rejected it
    await letGo(ctx, slug, []);
    deps.log(`${slug} is ${fm.status}; released`);
    return { action: 'done', effort: slug };
  }
  ctx.holding.phase = r.phase;
  const keys = resolveRepoKeys(clone, slug);
  if (keys.length && fm.status !== 'ACCEPTED') {
    try {
      if (!ctx.holding.prepared) { // a new hold starts from what was pushed (Ruling P2-11)
        salvage(ctx, { paths: [], reason: `fresh claim of ${slug}` });
        const stamp = iso(deps.now()).replace(/[-:]/g, '');
        for (const n of prepareCheckouts(clone, slug, keys, stamp, { continued: ctx.holding.continued })) deps.log(n);
        ctx.holding.prepared = true;
        writeState(home, { prepared: { slug, claimed_at: fm.claimed_at } });
      }
      deps.assemble({ rootDir: clone, slug, keys, hooks: { workerId: cfg.id } });
    } catch (e) {
      return effortError(ctx, slug, fm.status, `assemble-env failed: ${firstLine(e)}`, { keys });
    }
  }

  const prompt = buildPrompt({
    workerId: cfg.id, slug, status: fm.status, agent: cfg.agent, agentInput, developmentDone,
  });
  const unsafe = runDirProblem(clone);
  if (unsafe) return workerError(ctx, unsafe, unsafe, keys);
  const cmd = agentCommand(cfg, prompt, home);
  excludeRunDir(clone, RUN_DIR); // the result file is written inside meta/
  const logPath = runLogPath(home, deps.now(), slug, r.phase);
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, `[worker] ${cfg.id} ${r.phase} ${slug} (${fm.status}) at ${iso(deps.now())}\n`);
  const half = bcfg.leaseTtlMs / 2;
  let lastRenew = deps.now().getTime();
  let inflight = Promise.resolve();
  // The run stops when the worker is asked to stop (ctx.signal) or when a renew finds the claim taken.
  const run = new AbortController();
  let takenOver = false;
  const stopRun = () => run.abort();
  if (ctx.signal?.aborted) run.abort();
  else ctx.signal?.addEventListener('abort', stopRun, { once: true });
  const renewIfDue = async () => {
    const t = deps.now();
    if (t.getTime() - lastRenew < half) return;
    let rr;
    try {
      rr = await renew(clone, slug, { claimant: cfg.id, identity, workerId: cfg.id, now: t, hooks: deps.hooks });
    } catch (e) { rr = { ok: false, reason: firstLine(e) }; }
    if (rr.ok) lastRenew = t.getTime(); // a failed renew is retried on the next tick, not ttl/2 later
    if (!rr.ok && rr.reason === 'replaced') {
      takenOver = true;
      deps.log(`${slug} is no longer ours; stopping the agent`);
      run.abort();
      return;
    }
    deps.log(rr.ok ? `renewed ${slug}` : `could not renew ${slug} (${rr.reason}); retrying`);
  };
  const onTick = () => { inflight = renewIfDue(); return inflight; };
  deps.log(`running ${r.phase} for ${slug}`);
  let res;
  try {
    res = await deps.runAgent({
      ...cmd, env: { ...cmd.env, ...identityEnv(identity) }, cwd: clone, timeoutMs: bcfg.phaseTimeoutMs, logPath,
      onTick, tickMs: Math.max(50, Math.min(60e3, half / 4)), signal: run.signal, pidFile: join(home, 'run', 'agent.pid'),
    });
  } finally {
    ctx.signal?.removeEventListener('abort', stopRun);
  }
  await inflight.catch(() => {}); // a renew still pushing must land before the report touches the clone
  restoreMain(ctx); // the agent may have switched branches in meta
  unwindLocalCommits(ctx); // or committed there, despite the prompt
  if (takenOver) return lose(ctx, slug);
  if (res.aborted) return interrupted(ctx, slug, fm.status, keys);
  ctx.holding.pending = { status: fm.status, res, keys, logPath };
  return finishRun(ctx, slug, ctx.holding.pending, bcfg);
}

// Handle a finished run's result; it stays pending until handling returns (a throw keeps it for a retry).
async function finishRun(ctx, slug, { status, res, keys, logPath }, bcfg) {
  const out = await handleResult(ctx, slug, status, { res, keys, logPath, bcfg });
  if (ctx.holding?.slug === slug) ctx.holding.pending = null;
  return out;
}
