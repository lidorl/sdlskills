// What happens after a step's agent run, and the ways a step lets go of an effort: report, request,
// effort error, worker error, lost. Shared state: ctx from loop.mjs.
import { join } from 'node:path';
import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fetchMain, snapshotMain, identityEnv } from '../board/git.mjs';
import { release, holds, committedFm } from '../board/claims.mjs';
import { listRequests, postRequest, newRequestId } from '../board/requests.mjs';
import { redact } from '../board/redact.mjs';
import { reportPaths } from '../board/paths.mjs';
import { reportEffort } from '../board/report.mjs';
import { resolveRepoKeys } from '../../assemble-env.mjs';
import { readState, writeState } from './home.mjs';
import { readResult, classifyFailure } from './agent.mjs';
import { pushCodeBranches, dirtyNote } from './code-repos.mjs';

const firstLine = (e) => String(e?.message ?? e).split('\n')[0];
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const lastLines = (text, n) => text.replace(/\n+$/, '').split('\n').slice(-n).join('\n');

// ---- agent input persisted across a crash (Ruling P2-3) --------------------------------------
const inputFile = (home) => join(home, 'run', 'agent-input.json');
export function readInput(home) {
  try {
    const j = JSON.parse(readFileSync(inputFile(home), 'utf8'));
    return j && typeof j.slug === 'string' && Array.isArray(j.agentInput) ? j : null;
  } catch { return null; }
}
export function writeInput(home, slug, agentInput) {
  mkdirSync(join(home, 'run'), { recursive: true });
  writeFileSync(inputFile(home), `${JSON.stringify({ slug, agentInput }, null, 2)}\n`);
}
export const clearInput = (home) => rmSync(inputFile(home), { force: true });

export function lose(ctx, slug) {
  const fm = committedFm(ctx.clone, slug, 'origin/main');
  const why = fm?.claimed_by && fm.claimed_by !== ctx.cfg.id ? `now held by ${fm.claimed_by}` : `it is ${fm?.status ?? 'gone'} on main`;
  ctx.deps.log(`lost ${slug}: ${why}; nothing more is pushed for it`);
  ctx.holding = null;
  clearInput(ctx.home);
  return { action: 'lost', effort: slug };
}

export async function handleResult(ctx, slug, status, { res, keys, logPath, bcfg }) {
  const { cfg, home, clone, identity } = ctx;
  fetchMain(clone, identityEnv(identity));
  if (!holds(clone, slug, cfg.id, { ref: 'origin/main' })) return lose(ctx, slug);
  const read = readResult(join(home, 'run', 'result.json'));
  const exitFailed = !!res.spawnError || res.exitCode !== 0;
  if (!res.timedOut && exitFailed && classifyFailure(res) === 'worker') {
    const what = res.spawnError ? `agent CLI could not start: ${firstLine(res.spawnError)}` : 'the agent CLI rejected the run (model or CLI problem)';
    return workerError(ctx, what, res.stderrTail || what, keys);
  }
  if (res.timedOut || exitFailed || !read.ok || read.result.outcome === 'failed') {
    let message;
    if (res.timedOut) message = `agent run timed out after ${bcfg.phaseTimeoutMs / 1000}s`;
    else if (res.spawnError) message = `agent could not start: ${firstLine(res.spawnError)}`;
    else if (res.exitCode !== 0) message = `agent exited with code ${res.exitCode}${res.signal ? ` (${res.signal})` : ''}`;
    else if (!read.ok) message = read.problem;
    else message = read.result.error.message;
    const tried = read.ok ? (read.result.error?.tried ?? read.result.summary) : null;
    return effortError(ctx, slug, status, message, { keys, logPath, tried });
  }
  const result = read.result;
  return result.outcome === 'request'
    ? handleRequest(ctx, slug, status, result, keys)
    : handleCompleted(ctx, slug, status, result, keys);
}

function effortDirty(clone, slug) {
  const paths = reportPaths(clone, slug);
  if (!paths.length) return false;
  return execFileSync('git', ['status', '--porcelain', '--', ...paths], { cwd: clone, encoding: 'utf8' }).trim() !== '';
}

// Push the code branches, then report. -> { ok: true } or { ok: false, ret: <step result> }
async function report(ctx, slug, status, phase, { keys, summary }) {
  const { cfg, deps, clone, identity } = ctx;
  const code = pushCodeBranches(clone, slug, keys);
  if (code.failed.length) {
    const msg = `code push rejected: ${code.failed.map((f) => `workspace/${f.key}: ${f.error}`).join('; ')}`;
    return { ok: false, ret: await effortError(ctx, slug, status, msg, {}) };
  }
  const body = [summary && oneLine(redact(summary)), code.dirty.length && dirtyNote(code.dirty)].filter(Boolean).join('\n\n');
  const r = await reportEffort(clone, slug, {
    phase, claimant: cfg.id, identity, workerId: cfg.id, now: deps.now(), sleep: deps.sleep, hooks: deps.hooks, body,
  });
  if (r.ok || r.reason === 'nothing-to-do') { deps.log(`reported ${slug} at ${phase}${r.ok ? '' : ' (nothing new)'}`); return { ok: true }; }
  if (['not-holder', 'closed', 'landed'].includes(r.reason)) return { ok: false, ret: lose(ctx, slug) };
  const left = r.reason === 'unmerged'
    ? `the edits conflict with origin/main and are left as they are: ${r.paths.join(', ')}`
    : `kept on disk: ${(r.kept ?? []).join(', ') || 'none'}; feat-req edits were not kept`;
  return { ok: false, ret: await effortError(ctx, slug, status, `the report did not land (${r.reason}); ${left}`, {}) };
}

function warnStrays(ctx, slug) {
  const out = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: ctx.clone, encoding: 'utf8' });
  const strays = out.split('\0').filter(Boolean).map((rec) => rec.slice(3));
  if (strays.length) ctx.deps.log(`warning: edits outside ${slug}'s docs were not committed: ${strays.join(', ')}`);
}

async function handleCompleted(ctx, slug, status, result, keys) {
  const { home } = ctx;
  const rep = await report(ctx, slug, status, result.phase, { keys, summary: result.summary });
  if (!rep.ok) return rep.ret;
  writeState(home, { failures: 0, backoff_until: null });
  clearInput(home);
  warnStrays(ctx, slug);
  if (result.phase === 'IMPLEMENTED') {
    await letGo(ctx, slug, keys);
    return { action: 'done', effort: slug };
  }
  ctx.holding.developmentDone = result.development_done === true;
  return { action: 'reported', effort: slug };
}

async function handleRequest(ctx, slug, status, result, keys) {
  const { cfg, deps, home, clone, identity } = ctx;
  const q = result.request;
  if (effortDirty(clone, slug)) { // a gate asks about what the agent wrote: publish it first
    const rep = await report(ctx, slug, status, status, { keys, summary: result.summary });
    if (!rep.ok) return rep.ret;
  } else if (q.blocking) {
    pushCodeBranches(clone, slug, keys);
  }
  const now = deps.now();
  // v1: `for: owner` (or none) goes to the worker's owner; see the task 5 report.
  const forWho = !q.for || q.for === 'owner' ? cfg.owner : q.for;
  const req = {
    id: newRequestId(now, deps.rand), kind: q.kind, gate: q.gate ?? null, scope: 'effort', effort: slug, phase: status,
    worker: cfg.id, for: forWho, blocking: q.blocking, now, sections: q.sections,
  };
  const r = await postRequest(clone, req, {
    identity, workerId: cfg.id, releaseFrom: q.blocking ? { slug, claimant: cfg.id } : undefined, sleep: deps.sleep, hooks: deps.hooks,
  });
  if (!r.ok) {
    if (r.reason === 'replaced') return lose(ctx, slug);
    if (r.reason === 'invalid') return effortError(ctx, slug, status, `the agent's request is invalid: ${r.problems.join('; ')}`, {});
    deps.log(`could not post the request for ${slug} (${r.reason}); staying idle`);
    return { action: 'idle' };
  }
  clearInput(home);
  if (q.blocking) ctx.holding = null;
  deps.log(`posted ${q.kind} ${r.id} for ${slug}${q.blocking ? '; released while it waits' : ''}`);
  return { action: 'requested', effort: slug };
}

// Push the code branches, then release.
export async function letGo(ctx, slug, keys) {
  const { cfg, deps, clone, identity } = ctx;
  pushCodeBranches(clone, slug, keys);
  const r = await release(clone, slug, { claimant: cfg.id, identity, workerId: cfg.id, hooks: deps.hooks });
  if (!r.ok) deps.log(`could not release ${slug} (${r.reason})`);
  ctx.holding = null;
  clearInput(ctx.home);
}

// A blocking effort error: code pushed, error posted with the redacted log tail, released in the same commit.
export async function effortError(ctx, slug, status, message, { keys = [], logPath, tried }) {
  const { cfg, deps, home, clone, identity } = ctx;
  const code = pushCodeBranches(clone, slug, keys);
  const tail = logPath && existsSync(logPath) ? lastLines(readFileSync(logPath, 'utf8'), 50) : '';
  const now = deps.now();
  const context = [
    `tried: ${tried ? oneLine(tried) : '(no result summary)'}`,
    ...code.failed.map((f) => `push of workspace/${f.key} failed: ${f.error}`),
    ...(code.dirty.length ? [dirtyNote(code.dirty)] : []),
  ].join('\n');
  const req = {
    id: newRequestId(now, deps.rand), kind: 'error', scope: 'effort', effort: slug, phase: status, worker: cfg.id,
    for: cfg.owner, blocking: true, now,
    sections: {
      Request: redact(`Worker ${cfg.id} could not finish ${slug} (${status}): ${message}. Answer retry to resume, park to park it, or text with instructions.`),
      Context: redact(context),
      Error: tail || message,
    },
  };
  const r = await postRequest(clone, req, { identity, workerId: cfg.id, releaseFrom: { slug, claimant: cfg.id }, sleep: deps.sleep, hooks: deps.hooks });
  ctx.holding = null;
  clearInput(home);
  const { failures: prev } = readState(home);
  const failures = prev + 1;
  const backoff = ctx.board.backoffMs;
  const until = new Date(now.getTime() + backoff[Math.min(failures - 1, backoff.length - 1)]).toISOString();
  writeState(home, { failures, backoff_until: until });
  deps.log(r.ok ? `effort error on ${slug}: ${message}; backing off until ${until}` : `effort error on ${slug} (${message}) could not be posted (${r.reason})`);
  if (!r.ok && r.reason === 'replaced') return lose(ctx, slug);
  return { action: 'failed', effort: slug };
}

// A worker error (one open per worker): let go of any held effort, then post it unless one is already open.
export async function workerError(ctx, problem, excerpt, keys) {
  const { cfg, deps, clone, identity } = ctx;
  if (ctx.holding) await letGo(ctx, ctx.holding.slug, keys ?? resolveRepoKeys(clone, ctx.holding.slug));
  fetchMain(clone, identityEnv(identity));
  const snap = snapshotMain(clone);
  let open;
  try {
    open = listRequests(snap.dir).requests.filter((r) => r.fm.kind === 'error' && r.fm.scope === 'worker'
      && r.fm.worker === cfg.id && r.fm.status === 'open');
  } finally { snap.cleanup(); }
  if (open.length) {
    deps.log(`needs attention: ${problem} (worker error ${open[0].id} is already open)`);
    return { action: 'needs-attention' };
  }
  const now = deps.now();
  const r = await postRequest(clone, {
    id: newRequestId(now, deps.rand), kind: 'error', scope: 'worker', worker: cfg.id, for: cfg.owner, blocking: true, now,
    sections: {
      Request: redact(`Worker ${cfg.id} needs attention: ${problem}. Fix it, then answer resolved.`),
      Context: `Worker ${cfg.id} (${cfg.agent}, model ${cfg.model}) stopped taking work until this is answered.`,
      Error: excerpt || problem,
    },
  }, { identity, workerId: cfg.id, sleep: deps.sleep, hooks: deps.hooks });
  deps.log(r.ok ? `worker error posted: ${problem}` : `worker error (${problem}) could not be posted (${r.reason})`);
  return { action: 'needs-attention' };
}
