// Headless agent invocation: routing, prompt, CLI command, one supervised run, the result file.
import { spawn } from 'node:child_process';
import { readFileSync, appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';

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

export function agentCommand(cfg, prompt, home) {
  const cmd = cfg.agent_cmd ?? cfg.agent;
  const extra = cfg.cli_args ?? [];
  const args = cfg.agent === 'copilot'
    ? ['-p', prompt, '--model', cfg.model, '--allow-all-tools', '--no-color', ...extra]
    : ['-p', prompt, '--model', cfg.model, '--output-format', 'json',
      '--settings', join(home, 'agent-settings.json'), ...extra];
  const env = {
    SDLC_RESULT_FILE: join(home, 'run', 'result.json'),
    SDLC_WORKER_ID: cfg.id,
    SDLC_HEADLESS: '1',
  };
  return { cmd, args, env };
}

const lastLines = (text, n) => text.split('\n').filter((l, i, a) => l !== '' || i < a.length - 1).slice(-n).join('\n');

export function runAgent({ cmd, args = [], env = {}, cwd, timeoutMs, logPath, onTick, tickMs = 1000 }) {
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
      child = spawn(cmd, args, {
        cwd, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (spawnError) {
      resolve({ spawnError });
      return;
    }

    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killTimer;
    let ticking = false;
    let tickTimer;

    const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { /* already gone */ } };

    child.stdout.on('data', (d) => log(d));
    child.stderr.on('data', (d) => {
      log(d);
      stderr += d.toString();
      if (stderr.length > 1_000_000) stderr = stderr.slice(-500_000);
    });

    const timeout = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), 5000);
    }, timeoutMs) : null;

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
      resolve(result);
    };

    child.on('error', (spawnError) => finish({ spawnError }));
    child.on('close', (exitCode, signal) => {
      killGroup('SIGKILL'); // stragglers left in the group
      finish({ exitCode, signal, timedOut, stderrTail: lastLines(stderr, 50) });
    });
  });
}

export function readResult(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch (e) {
    return { ok: false, problem: e.code === 'ENOENT' ? 'result file missing' : `result file unreadable: ${e.message}` };
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
