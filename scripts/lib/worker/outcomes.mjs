// What happens after a step's agent run, and the ways a step lets go of an effort: report, request,
// effort error, worker error, lost. Shared state: ctx from loop.mjs.
import { hostname } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fetchMain, snapshotMain, identityEnv } from '../board/git.mjs';
import { release, holds, committedFm } from '../board/claims.mjs';
import { listRequests, postRequest, newRequestId } from '../board/requests.mjs';
import { redact } from '../board/redact.mjs';
import { reportPaths } from '../board/paths.mjs';
import { reportEffort } from '../board/report.mjs';
import { resolveRepoKeys } from '../../assemble-env.mjs';
import { readState, writeState } from './home.mjs';
import { readResult, classifyFailure, resultFile } from './agent.mjs';
import { pushCodeBranches, dirtyNote } from './code-repos.mjs';
import { readInput, clearInput } from './agent-input.mjs';
import { salvage } from './salvage.mjs';

const firstLine = (e) => String(e?.message ?? e).split('\n')[0];
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const lastLines = (text, n) => text.replace(/\n+$/, '').split('\n').slice(-n).join('\n');
export const STALL_LIMIT = 3; // completed runs in a row that change nothing before an effort error

// The hold is over: forget it, and its prepared-checkouts marker (Ruling P2-14).
function endHold(ctx, slug) {
  ctx.holding = null;
  if (readState(ctx.home).prepared?.slug === slug) writeState(ctx.home, { prepared: null });
}

const failedPushes = (code) => code.failed.map((f) => `push of workspace/${f.key} failed: ${f.error}`);

// Answers applied but not yet acted on by a run that finished: they stay saved, and the error says so.
function pending(ctx, slug) {
  const input = readInput(ctx.home, slug);
  return input.length ? [`instructions not yet acted on (kept for the next run):\n${input.map((a) => `- ${oneLine(a)}`).join('\n')}`] : [];
}

export function lose(ctx, slug) {
  const fm = committedFm(ctx.clone, slug, 'origin/main');
  const why = fm?.claimed_by && fm.claimed_by !== ctx.cfg.id ? `now held by ${fm.claimed_by}` : `it is ${fm?.status ?? 'gone'} on main`;
  ctx.deps.log(`lost ${slug}: ${why}; nothing more is pushed for it`);
  salvage(ctx, { reason: `lost ${slug}` });
  endHold(ctx, slug);
  return { action: 'lost', effort: slug };
}

export async function handleResult(ctx, slug, status, { res, keys, logPath, bcfg }) {
  const { cfg, home, clone, identity } = ctx;
  fetchMain(clone, identityEnv(identity));
  if (!holds(clone, slug, cfg.id, { ref: 'origin/main' })) return lose(ctx, slug);
  const read = readResult(resultFile(home));
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

// Push the code branches, then report. -> { ok: true, codeAdvanced } or { ok: false, ret: <step result> }
async function report(ctx, slug, status, phase, { keys, summary }) {
  const { cfg, deps, clone, identity } = ctx;
  const code = pushCodeBranches(clone, slug, keys);
  if (code.failed.length) {
    return { ok: false, ret: await effortError(ctx, slug, status, `code push rejected: ${failedPushes(code).join('; ')}`, {}) };
  }
  const body = [summary && oneLine(redact(summary)), code.dirty.length && dirtyNote(code.dirty)].filter(Boolean).join('\n\n');
  const r = await reportEffort(clone, slug, {
    phase, claimant: cfg.id, identity, workerId: cfg.id, now: deps.now(), sleep: deps.sleep, hooks: deps.hooks, body, fetched: true,
  });
  if (r.ok || r.reason === 'nothing-to-do') {
    deps.log(`reported ${slug} at ${phase}${r.ok ? '' : ' (nothing new)'}`);
    return { ok: true, codeAdvanced: code.advanced.length > 0 };
  }
  if (['not-holder', 'closed', 'landed'].includes(r.reason)) return { ok: false, ret: lose(ctx, slug) };
  const what = r.reason === 'unmerged'
    ? `the edits to ${r.paths.join(', ')} conflict with origin/main`
    : `the push lost (${r.reason}); kept on disk: ${(r.kept ?? []).join(', ') || 'none'}; feat-req edits were not kept`;
  return { ok: false, ret: await effortError(ctx, slug, status, `the report did not land: ${what}`, {}) };
}

function warnStrays(ctx, slug) {
  const out = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: ctx.clone, encoding: 'utf8' });
  const strays = out.split('\0').filter(Boolean).map((rec) => rec.slice(3));
  if (strays.length) ctx.deps.log(`warning: edits outside ${slug}'s docs were not committed: ${strays.join(', ')}`);
}

async function handleCompleted(ctx, slug, status, result, keys) {
  const { home } = ctx;
  const changed = effortDirty(ctx.clone, slug);
  const rep = await report(ctx, slug, status, result.phase, { keys, summary: result.summary });
  if (!rep.ok) return rep.ret;
  writeState(home, { failures: 0, backoff_until: null });
  clearInput(home, slug);
  warnStrays(ctx, slug);
  if (result.phase === 'IMPLEMENTED') {
    await letGo(ctx, slug, keys);
    return { action: 'done', effort: slug };
  }
  const done = result.development_done === true;
  const progressed = changed || rep.codeAdvanced || result.phase !== status || (done && !ctx.holding.developmentDone);
  ctx.holding.stalls = progressed ? 0 : (ctx.holding.stalls ?? 0) + 1;
  ctx.holding.developmentDone = done;
  if (ctx.holding.stalls >= STALL_LIMIT) {
    return effortError(ctx, slug, status, `no progress: ${STALL_LIMIT} completed runs in a row changed nothing`, { keys, tried: result.summary });
  }
  return { action: 'reported', effort: slug };
}

async function handleRequest(ctx, slug, status, result, keys) {
  const { cfg, deps, home, clone, identity } = ctx;
  const q = result.request;
  if (effortDirty(clone, slug)) { // a gate asks about what the agent wrote: publish it first
    const rep = await report(ctx, slug, status, status, { keys, summary: result.summary });
    if (!rep.ok) return rep.ret;
  } else if (q.blocking) {
    const code = pushCodeBranches(clone, slug, keys);
    if (code.failed.length) return effortError(ctx, slug, status, `code push rejected: ${failedPushes(code).join('; ')}`, {});
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
  clearInput(home, slug);
  if (q.blocking) {
    salvage(ctx, { reason: `released ${slug} for request ${r.id}` });
    endHold(ctx, slug);
  }
  deps.log(`posted ${q.kind} ${r.id} for ${slug}${q.blocking ? '; released while it waits' : ''}`);
  return { action: 'requested', effort: slug };
}

// The worker was stopped mid-run: publish what the agent got done (code branches, the effort's changed docs,
// with keep-work semantics on a lost push), then release. -> { action: 'interrupted' } or the report's outcome
export async function interrupted(ctx, slug, status, keys) {
  const { cfg, clone, identity, deps } = ctx;
  fetchMain(clone, identityEnv(identity));
  if (!holds(clone, slug, cfg.id, { ref: 'origin/main' })) return lose(ctx, slug);
  if (effortDirty(clone, slug)) {
    const rep = await report(ctx, slug, status, status, { keys, summary: 'progress so far; the worker was stopped mid-run' });
    if (!rep.ok) return rep.ret;
  }
  await letGo(ctx, slug, keys);
  deps.log(`interrupted ${slug}: released`);
  return { action: 'interrupted', effort: slug };
}

// Push the code branches, move any leftovers aside, then release. -> the salvage dir or null
export async function letGo(ctx, slug, keys) {
  const { cfg, deps, clone, identity } = ctx;
  const code = pushCodeBranches(clone, slug, keys);
  for (const f of failedPushes(code)) deps.log(`warning: ${f}; the commits stay in the local branch`);
  const dir = salvage(ctx, { reason: `released ${slug}` });
  const r = await release(clone, slug, { claimant: cfg.id, identity, workerId: cfg.id, hooks: deps.hooks });
  if (!r.ok) deps.log(`could not release ${slug} (${r.reason})`);
  endHold(ctx, slug);
  return dir;
}

// A blocking effort error: code pushed, leftovers salvaged, error posted with the redacted log tail, and
// released in the same commit. Unapplied answers stay saved and are listed.
export async function effortError(ctx, slug, status, message, { keys = [], logPath, tried }) {
  const { cfg, deps, home, clone, identity } = ctx;
  const code = pushCodeBranches(clone, slug, keys);
  const dir = salvage(ctx, { reason: `effort error on ${slug}` });
  const tail = logPath && existsSync(logPath) ? lastLines(readFileSync(logPath, 'utf8'), 50) : '';
  const now = deps.now();
  const context = [
    `tried: ${tried ? oneLine(tried) : '(no result summary)'}`,
    ...failedPushes(code),
    ...(code.dirty.length ? [dirtyNote(code.dirty)] : []),
    ...(dir ? [`uncommitted edits were moved to ${dir} on host ${hostname()}`] : []),
    ...pending(ctx, slug),
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
  endHold(ctx, slug);
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
  const held = ctx.holding?.slug;
  const notes = held ? pending(ctx, held).map((p) => `${held}: ${p}`) : [];
  const dir = held ? await letGo(ctx, held, keys ?? resolveRepoKeys(clone, held)) : null;
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
  const context = [
    `Worker ${cfg.id} (${cfg.agent}, model ${cfg.model}) stopped taking work until this is answered.`,
    ...(held ? [`It released ${held}.`] : []),
    ...(dir ? [`Uncommitted edits were moved to ${dir} on host ${hostname()}.`] : []),
    ...notes,
  ].join('\n');
  const r = await postRequest(clone, {
    id: newRequestId(now, deps.rand), kind: 'error', scope: 'worker', worker: cfg.id, for: cfg.owner, blocking: true, now,
    sections: {
      Request: redact(`Worker ${cfg.id} needs attention: ${problem}. Fix it, then answer resolved.`),
      Context: redact(context),
      Error: excerpt || problem,
    },
  }, { identity, workerId: cfg.id, sleep: deps.sleep, hooks: deps.hooks });
  deps.log(r.ok ? `worker error posted: ${problem}` : `worker error (${problem}) could not be posted (${r.reason})`);
  return { action: 'needs-attention' };
}
