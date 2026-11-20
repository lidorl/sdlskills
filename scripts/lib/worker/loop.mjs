// The worker loop step: one iteration of docs/design/workers.md "The worker loop". A step holds at most one
// effort; between steps that is ctx.holding (memory) plus <home>/run/agent-input.json (Ruling P2-3).
// What follows the agent run (report, request, errors) is in outcomes.mjs.
import { join, dirname } from 'node:path';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fetchMain, snapshotMain, boardWrite, identityEnv, BoardError } from '../board/git.mjs';
import { claim, renew, holds, committedFm, claimState } from '../board/claims.mjs';
import { loadEfforts, rank, overlaps } from '../board/queue.mjs';
import { listRequests } from '../board/requests.mjs';
import { applyAnswered, applyClosed } from '../board/effects.mjs';
import { loadConfig } from '../board/config.mjs';
import { syncKeepingWork, SyncConflict } from '../board/report.mjs';
import { loadCatalog } from '../catalog.mjs';
import { assemble as realAssemble, resolveRepoKeys } from '../../assemble-env.mjs';
import { readConfig, readState } from './home.mjs';
import { route, buildPrompt, agentCommand, runAgent as realRunAgent } from './agent.mjs';
import { preflight, realDeps as preflightDeps } from './preflight.mjs';
import {
  readInput, writeInput, clearInput, lose, letGo, effortError, workerError, handleResult,
} from './outcomes.mjs';

// A problem the worker must not write past (unregistered, retired, config/registry mismatch): stop.
export class WorkerFatal extends Error {}

const CANDIDATE = new Set(['ACCEPTED', 'DESIGNED', 'PLANNED', 'IN_PROGRESS']);
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const firstLine = (e) => String(e?.message ?? e).split('\n')[0];

export function makeContext({ home, deps = {} }) {
  const cfg = readConfig(home);
  const pf = preflightDeps();
  return {
    home, cfg, clone: join(home, 'meta'), holding: null,
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

// ---- the step ---------------------------------------------------------------------------------

export async function step(ctx) {
  try {
    fetchMain(ctx.clone, identityEnv(ctx.identity));
  } catch (e) {
    ctx.deps.log(`cannot reach origin: ${firstLine(e)}; staying idle`);
    return { action: 'idle' };
  }
  const snap = snapshotMain(ctx.clone);
  try {
    return await stepOn(ctx, snap.dir);
  } catch (e) {
    if (!(e instanceof BoardError)) throw e;
    ctx.deps.log(`board write failed: ${firstLine(e)}; staying idle`);
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
  const persisted = readInput(home);
  let slug = ctx.holding?.slug ?? null;
  if (slug) {
    if (!holds(clone, slug, cfg.id, { ref: 'origin/main' })) return lose(ctx, slug);
  } else if (persisted && holds(clone, persisted.slug, cfg.id, { ref: 'origin/main' })) {
    slug = persisted.slug;
    ctx.holding = { slug, developmentDone: false };
    deps.log(`resuming ${slug} with its saved agent input`);
  } else {
    if (persisted) clearInput(home);
    const { backoff_until: until } = readState(home);
    if (until && now < new Date(until)) {
      deps.log(`backing off until ${until}`);
      return { action: 'idle' };
    }
    slug = await pickAndClaim(ctx, board, bcfg, now);
    if (!slug) {
      await applyOnClosed(ctx, now);
      return { action: 'idle' };
    }
    ctx.holding = { slug, developmentDone: false };
  }
  return runHeld(ctx, slug, bcfg);
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

// In-flight before new: our own live claims first, then the ranked queue. Returns the claimed slug or null.
async function pickAndClaim(ctx, board, bcfg, now) {
  const { cfg, deps, clone, identity } = ctx;
  const ttlMs = bcfg.leaseTtlMs;
  const { efforts } = loadEfforts(board);
  const openIds = new Set(listRequests(board).requests.filter((r) => r.fm.status === 'open').map((r) => r.id));
  const ours = efforts.filter((e) => CANDIDATE.has(e.status) && e.fm?.claimed_by === cfg.id && claimState(e.fm, now, ttlMs) === 'live');
  const ro = readonlyKeys(clone);
  for (const e of [...ours, ...rank(efforts, { now, ttlMs, openRequestIds: openIds })]) {
    const warnings = overlaps(e, efforts, { now, ttlMs, readonlyKeys: ro })
      .map((o) => `${e.slug} shares ${o.repos.join(', ')} with ${o.slug}`);
    for (const w of warnings) deps.log(`warning: ${w}`);
    const r = await claim(clone, e.slug, {
      claimant: cfg.id, identity, workerId: cfg.id, now, ttlMs, hooks: deps.hooks,
      body: warnings.length ? `Overlap warning:\n${warnings.map((w) => `- ${w}`).join('\n')}` : undefined,
    });
    if (r.ok) {
      deps.log(r.takeover ? `took over ${e.slug} from ${r.takeover}` : `claimed ${e.slug}`);
      return e.slug;
    }
    deps.log(`could not claim ${e.slug} (${r.reason})`);
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

async function runHeld(ctx, slug, bcfg) {
  const { cfg, deps, home, clone, identity } = ctx;
  const a = await applyAnswered(clone, slug, { claimant: cfg.id, identity, workerId: cfg.id, now: deps.now(), rand: deps.rand, hooks: deps.hooks });
  if (!a.ok) {
    if (a.reason === 'replaced') return lose(ctx, slug);
    deps.log(`could not apply answers for ${slug} (${a.reason}); staying idle`);
    return { action: 'idle' };
  }
  for (const p of a.problems) deps.log(`warning: request ${p.id} not applied: ${p.problems.join('; ')}`);
  const persisted = readInput(home);
  const agentInput = [...(persisted?.slug === slug ? persisted.agentInput : []), ...a.agentInput];
  if (agentInput.length) writeInput(home, slug, agentInput);

  const fm = committedFm(clone, slug, 'origin/main');
  if (!fm || fm.claimed_by !== cfg.id) return lose(ctx, slug);
  try {
    syncKeepingWork(clone, identityEnv(identity)); // the agent works on what main says now (applied answers included)
  } catch (e) {
    if (!(e instanceof SyncConflict)) throw e;
    return effortError(ctx, slug, fm.status, `local edits conflict with origin/main (${e.paths.join(', ')}); they are left as they are`, {});
  }
  const r = route(fm.status, { developmentDone: ctx.holding.developmentDone });
  if (!r) { // an answer parked or rejected it
    await letGo(ctx, slug, []);
    deps.log(`${slug} is ${fm.status}; released`);
    return { action: 'done', effort: slug };
  }
  const keys = resolveRepoKeys(clone, slug);
  if (keys.length && fm.status !== 'ACCEPTED') {
    try {
      deps.assemble({ rootDir: clone, slug, keys, hooks: { workerId: cfg.id } });
    } catch (e) {
      return effortError(ctx, slug, fm.status, `assemble-env failed: ${firstLine(e)}`, { keys });
    }
  }

  const prompt = buildPrompt({
    workerId: cfg.id, slug, status: fm.status, agent: cfg.agent, agentInput, developmentDone: ctx.holding.developmentDone,
  });
  const cmd = agentCommand(cfg, prompt, home);
  const logPath = runLogPath(home, deps.now(), slug, r.phase);
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, `[worker] ${cfg.id} ${r.phase} ${slug} (${fm.status}) at ${iso(deps.now())}\n`);
  const half = bcfg.leaseTtlMs / 2;
  let lastRenew = deps.now().getTime();
  let inflight = Promise.resolve();
  const renewIfDue = async () => {
    const t = deps.now();
    if (t.getTime() - lastRenew < half) return;
    lastRenew = t.getTime();
    const rr = await renew(clone, slug, { claimant: cfg.id, identity, workerId: cfg.id, now: t, hooks: deps.hooks });
    deps.log(rr.ok ? `renewed ${slug}` : `could not renew ${slug} (${rr.reason})`);
  };
  const onTick = () => { inflight = renewIfDue(); return inflight; };
  deps.log(`running ${r.phase} for ${slug}`);
  const res = await deps.runAgent({
    ...cmd, env: { ...cmd.env, ...identityEnv(identity) }, cwd: clone, timeoutMs: bcfg.phaseTimeoutMs, logPath,
    onTick, tickMs: Math.max(50, Math.min(60e3, half / 4)),
  });
  await inflight.catch(() => {}); // a renew still pushing must land before the report touches the clone
  return handleResult(ctx, slug, fm.status, { res, keys, logPath, bcfg });
}
