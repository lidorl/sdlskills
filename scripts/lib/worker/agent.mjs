// Headless agent invocation: routing, prompt, CLI command, one supervised run, the result file.
import { spawn, execFileSync } from 'node:child_process';
import {
  readFileSync, appendFileSync, mkdirSync, rmSync, writeFileSync, lstatSync, openSync, fstatSync, closeSync, constants,
  existsSync, readdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { safePath } from '../board/safe-path.mjs';
import { isPlanPath } from '../board/paths.mjs';

const PHASE_STATUSES = ['ACCEPTED', 'DESIGNED', 'PLANNED', 'IN_PROGRESS', 'IMPLEMENTED'];
const REQUEST_KINDS = ['gate', 'question', 'clarification', 'error'];

export function route(status, { developmentDone = false } = {}) {
  switch (status) {
    case 'ACCEPTED': return { phase: 'design', skills: ['classify-change', 'write-design-doc'] };
    case 'DESIGNED': return { phase: 'plan', skills: ['write-execution-plan'] };
    case 'PLANNED': return { phase: 'develop', skills: ['executing-plans'] };
    case 'IN_PROGRESS':
      return developmentDone
        ? { phase: 'close-out', skills: ['close-out'] }
        : { phase: 'develop', skills: ['executing-plans'], resume: true };
    default: return null;
  }
}

// Development is done when the effort has a plan and every plan file is IMPLEMENTED or has no unchecked step.
// Durable (the plan is on main), unlike the agent's development_done, which is only a hint. The plans come
// from a shared repo: only the effort's own names, no symlinks or escapes (safePath), regular files only (a
// FIFO is never opened), at most PLAN_MAX_BYTES. Anything wrong counts as "not done" and is logged.
const PLAN_MAX_BYTES = 1024 * 1024;

function readPlan(root, rel) {
  const abs = safePath(root, rel);
  const st = lstatSync(abs);
  if (!st.isFile()) throw new Error(`${rel} is not a regular file`);
  if (st.size > PLAN_MAX_BYTES) throw new Error(`${rel} is larger than ${PLAN_MAX_BYTES} bytes`);
  const fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile() || fst.size > PLAN_MAX_BYTES) throw new Error(`${rel} changed while being read`);
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}

export function planDone(root, slug, { log = () => {} } = {}) {
  try {
    const dir = safePath(root, 'docs/plans');
    const files = existsSync(dir) ? readdirSync(dir).filter((n) => isPlanPath(slug, `docs/plans/${n}`)) : [];
    if (!files.length) return false;
    return files.every((n) => {
      const text = readPlan(root, `docs/plans/${n}`);
      const status = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1].match(/^status:\s*(\S+)/m)?.[1];
      return status === 'IMPLEMENTED' || !/^\s*[-*] \[ \]/m.test(text);
    });
  } catch (e) {
    log(`warning: cannot read ${slug}'s plan (${String(e?.message ?? e).split('\n')[0]}); treating development as not done`);
    return false;
  }
}

// The routed phase a worker records in the Context of a request it posts, so the answer goes back to it.
export const phaseNote = (phase) => `Worker phase: ${phase}`;
export const PHASE_MARK = /^Worker phase: (develop|close-out)\s*$/m;

const SUPERPOWERS = new Set(['executing-plans']);

function skillRef(skill, agent) {
  if (agent === 'copilot') {
    return SUPERPOWERS.has(skill)
      ? `the superpowers plugin's ${skill} skill`
      : `.github/skills/${skill}/SKILL.md`;
  }
  return SUPERPOWERS.has(skill) ? `/superpowers:${skill}` : `/${skill}`;
}

export function buildPrompt({ workerId, slug, status, agent, agentInput = [], developmentDone = false }) {
  const r = route(status, { developmentDone });
  if (!r) throw new Error(`no route for status ${status}`);
  const refs = r.skills.map((s) => skillRef(s, agent));
  const verb = agent === 'copilot' ? 'Follow' : 'Run';
  const parts = [
    `You are SDLC worker ${workerId}, running headless. Phase: ${r.phase} for effort ${slug}.`,
    `${verb} ${refs.join(' then ')}.`,
  ];
  if (r.resume) parts.push("Resume from the plan's first unchecked step.");
  parts.push(
    'Follow "Headless mode" in the process contract: you cannot ask anyone anything.',
    `Do not commit or push in the meta repo. Commit in code repos on \`feat/${slug}\` only.`,
  );
  if (agentInput.length) {
    parts.push(`Answered requests to apply first:\n${agentInput.map((a) => `- ${a}`).join('\n')}`);
  }
  parts.push('When you stop, write $SDLC_RESULT_FILE.');
  return parts.join('\n');
}

// The result file lives inside meta/ (the agent's cwd, where the sandbox lets it write), in a directory the
// meta clone's .git/info/exclude hides from git (see home.mjs excludeRunDir).
export const RUN_DIR = '.sdlc-run';
export const resultFile = (home) => join(home, 'meta', RUN_DIR, 'result.json');

// The meta clone mirrors a shared repo, so the repo itself could plant the run dir: a committed symlink would
// send the result file's mkdir/rm/read outside the clone, a tracked directory would put it under git. Checked
// before every run. -> a problem naming the path, or null
export function runDirProblem(clone) {
  const lst = (rel) => { try { return lstatSync(join(clone, rel), { throwIfNoEntry: false }); } catch (e) { return e; } };
  const dir = lst(RUN_DIR);
  if (dir instanceof Error) return `meta/${RUN_DIR} is unsafe: ${dir.message}`;
  if (dir?.isSymbolicLink()) return `meta/${RUN_DIR} is a symlink (the meta repo must not provide it)`;
  if (dir && !dir.isDirectory()) return `meta/${RUN_DIR} is not a directory`;
  let tracked;
  try {
    tracked = execFileSync('git', ['ls-files', '--', RUN_DIR], { cwd: clone, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) { return `cannot check meta/${RUN_DIR} with git ls-files: ${String(e.message).split('\n')[0]}`; }
  if (tracked) return `meta/${RUN_DIR} is tracked by the meta repo (${tracked.split('\n')[0]}); remove it from the repo`;
  const file = lst(`${RUN_DIR}/result.json`);
  if (file instanceof Error) return `meta/${RUN_DIR}/result.json is unsafe: ${file.message}`;
  if (file && !file.isFile()) return `meta/${RUN_DIR}/result.json is not a regular file`;
  return null;
}

export function agentCommand(cfg, prompt, home) {
  const cmd = cfg.agent_cmd ?? cfg.agent;
  const extra = cfg.cli_args ?? [];
  const args = cfg.agent === 'copilot'
    ? ['-p', prompt, '--model', cfg.model, '--allow-all-tools', '--no-color', ...extra]
    : ['-p', prompt, '--model', cfg.model, '--output-format', 'json',
      '--settings', join(home, 'agent-settings.json'), ...extra];
  const env = {
    SDLC_RESULT_FILE: resultFile(home),
    SDLC_WORKER_ID: cfg.id,
    SDLC_HEADLESS: '1',
  };
  return { cmd, args, env };
}

// Set by `sdlc worker start --detach` for the worker process itself (see worker/cli.mjs).
export const WORKER_PROCESS_VARS = ['SDLC_WORKER_DETACHED', 'SDLC_WORKER_PARENT_PID', 'SDLC_WORKER_LOCK_TOKENS'];

const lastLines = (text, n) => text.split('\n').filter((l, i, a) => l !== '' || i < a.length - 1).slice(-n).join('\n');

// `signal` (AbortSignal): on abort the agent's process group is killed and the run resolves { aborted: true }
// (with exitCode/signal/stderrTail when it had started); an already-aborted signal starts nothing.
// `pidFile`: holds the agent's pid (it leads its own process group) while it runs, so `sdlc worker stop` can
// kill an agent its worker left behind.
// The detached worker's own markers (WORKER_PROCESS_VARS) are not passed on to the agent.
export function runAgent({ cmd, args = [], env = {}, cwd, timeoutMs, logPath, onTick, tickMs = 1000, signal, pidFile }) {
  if (signal?.aborted) return Promise.resolve({ aborted: true });
  mkdirSync(dirname(logPath), { recursive: true });
  // A previous run's result must never be mistaken for this one's.
  if (env.SDLC_RESULT_FILE) {
    mkdirSync(dirname(env.SDLC_RESULT_FILE), { recursive: true });
    rmSync(env.SDLC_RESULT_FILE, { force: true });
  }
  const log = (s) => { try { appendFileSync(logPath, s); } catch { /* log is best effort */ } };

  return new Promise((resolve) => {
    let child;
    try {
      const base = { ...process.env };
      for (const k of WORKER_PROCESS_VARS) delete base[k];
      child = spawn(cmd, args, {
        cwd, env: { ...base, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (spawnError) {
      resolve({ spawnError });
      return;
    }

    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let killTimer;
    let ticking = false;
    let tickTimer;

    if (pidFile && child.pid) {
      try { mkdirSync(dirname(pidFile), { recursive: true }); writeFileSync(pidFile, `${child.pid}\n`); } catch { /* best effort */ }
    }
    const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { /* already gone */ } };

    child.stdout.on('data', (d) => log(d));
    child.stderr.on('data', (d) => {
      log(d);
      stderr += d.toString();
      if (stderr.length > 1_000_000) stderr = stderr.slice(-500_000);
    });

    const stop = () => {
      killGroup('SIGTERM');
      killTimer ??= setTimeout(() => killGroup('SIGKILL'), 5000);
    };
    const timeout = timeoutMs > 0 ? setTimeout(() => { timedOut = true; stop(); }, timeoutMs) : null;
    const onAbort = () => { aborted = true; log('\n[worker] run aborted: stopping the agent\n'); stop(); };
    signal?.addEventListener('abort', onAbort, { once: true });

    if (onTick) {
      tickTimer = setInterval(async () => {
        if (ticking || settled) return;
        ticking = true;
        try { await onTick(); } catch (e) { log(`\n[worker] onTick error: ${e?.message ?? e}\n`); }
        ticking = false;
      }, tickMs);
    }

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      clearInterval(tickTimer);
      signal?.removeEventListener('abort', onAbort);
      if (pidFile) rmSync(pidFile, { force: true });
      resolve(result);
    };

    child.on('error', (spawnError) => finish({ spawnError }));
    child.on('close', (exitCode, sig) => {
      killGroup('SIGKILL'); // stragglers left in the group
      const out = { exitCode, signal: sig, timedOut, stderrTail: lastLines(stderr, 50) };
      finish(aborted ? { aborted: true, ...out } : out);
    });
  });
}

// Read without following a symlink, and only from a regular file (the agent writes it; see runDirProblem).
function readRegular(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw Object.assign(new Error('not a regular file'), { code: 'ENOTREG' });
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}

export function readResult(path) {
  let raw;
  try { raw = readRegular(path); } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, problem: 'result file missing' };
    if (e.code === 'ELOOP') return { ok: false, problem: 'result file is a symlink' };
    return { ok: false, problem: `result file unreadable: ${e.message}` };
  }
  let r;
  try { r = JSON.parse(raw); } catch (e) { return { ok: false, problem: `result file is not valid JSON: ${e.message}` }; }
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, problem: 'result must be a JSON object' };
  const str = (v) => typeof v === 'string' && v.trim() !== '';
  const bad = (problem) => ({ ok: false, problem });

  switch (r.outcome) {
    case 'completed':
      if (!PHASE_STATUSES.includes(r.phase)) return bad(`completed result needs phase, one of ${PHASE_STATUSES.join('|')}`);
      if (!str(r.summary)) return bad('completed result needs a summary');
      break;
    case 'request': {
      const q = r.request;
      if (!q || typeof q !== 'object') return bad('request result needs a request object');
      if (!REQUEST_KINDS.includes(q.kind)) return bad(`request.kind must be one of ${REQUEST_KINDS.join('|')}`);
      if (!q.sections || typeof q.sections !== 'object') return bad('request.sections is required');
      if (!str(q.sections.Request)) return bad('request.sections.Request must be a non-empty string');
      if (!str(q.sections.Context)) return bad('request.sections.Context must be a non-empty string');
      if (typeof q.blocking !== 'boolean') return bad('request.blocking must be a boolean');
      break;
    }
    case 'failed':
      if (!r.error || !str(r.error.message)) return bad('failed result needs error.message');
      break;
    default:
      return bad(`unknown outcome: ${JSON.stringify(r.outcome)}`);
  }
  return { ok: true, result: r };
}

export function classifyFailure({ stderrTail = '', spawnError } = {}) {
  if (spawnError?.code === 'ENOENT') return 'worker';
  if (/model/i.test(stderrTail) && /not (found|available|supported)|invalid|unknown/i.test(stderrTail)) return 'worker';
  return 'effort';
}
