import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export const DEFAULT_CONFIG_YAML = `# board/config.yml — board and worker settings, shared by everyone on this board
lease_ttl: 4h            # a claim with no report or renewal for this long is stale, and anyone may take it over
idle_poll: 60s           # how often an idle worker pulls the board
phase_timeout: 3h        # the longest one agent run may take; must be shorter than lease_ttl
backoff: [5m, 15m, 60m]  # waits after consecutive effort errors
watch_interval: 30s      # default poll interval for \`sdlc watch\`
`;

const DEFAULTS = {
  lease_ttl: '4h',
  idle_poll: '60s',
  phase_timeout: '3h',
  backoff: ['5m', '15m', '60m'],
  watch_interval: '30s',
};
const DURATION_KEYS = ['lease_ttl', 'idle_poll', 'phase_timeout', 'watch_interval'];
const UNITS = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 };

export function parseDuration(s) {
  const m = typeof s === 'string' ? /^(\d+)([smhd])$/.exec(s) : null;
  if (!m) throw new Error(`invalid duration ${JSON.stringify(s)} (use <int>s|m|h|d, e.g. 4h)`);
  const ms = Number(m[1]) * UNITS[m[2]];
  if (ms <= 0) throw new Error(`invalid duration ${JSON.stringify(s)} (must be greater than 0)`);
  return ms;
}

function durationProblem(key, v) {
  try { parseDuration(v); return null; } catch (e) { return `${key}: ${e.message}`; }
}

export function validateConfig(obj) {
  const problems = [];
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return ['config: must be a mapping of keys to values'];
  }
  for (const [key, v] of Object.entries(obj)) {
    if (DURATION_KEYS.includes(key)) {
      const p = durationProblem(key, v);
      if (p) problems.push(p);
    } else if (key === 'backoff') {
      if (!Array.isArray(v) || v.length === 0) {
        problems.push('backoff: must be a non-empty list of durations');
      } else {
        for (const d of v) {
          const p = durationProblem('backoff', d);
          if (p) problems.push(p);
        }
      }
    } else {
      problems.push(`${key}: unknown key`);
    }
  }
  // A run must end inside one lease: a renew can fail while it runs, and a lease that runs out mid-run is
  // taken over. Checked against the defaults for whichever of the two is not set.
  // A bad value is already reported above, so it is skipped here.
  const value = (key) => (key in obj ? obj[key] : DEFAULTS[key]);
  const shown = (key) => (key in obj ? String(obj[key]) : `${DEFAULTS[key]} (default)`);
  const ms = (key) => { try { return parseDuration(value(key)); } catch { return null; } };
  const phase = ms('phase_timeout');
  const lease = ms('lease_ttl');
  if (phase !== null && lease !== null && phase >= lease) {
    problems.push(`phase_timeout (${shown('phase_timeout')}) must be shorter than lease_ttl (${shown('lease_ttl')}): set a shorter phase_timeout or a longer lease_ttl`);
  }
  return problems;
}

export function loadConfig(root) {
  const file = join(root, 'board', 'config.yml');
  let user = {};
  if (existsSync(file)) {
    let parsed;
    try {
      parsed = parse(readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`board/config.yml: invalid YAML: ${e.message}`);
    }
    user = parsed ?? {};
    const problems = validateConfig(user);
    if (problems.length) throw new Error(`board/config.yml: ${problems.join('; ')}`);
  }
  const c = { ...DEFAULTS, ...user };
  return {
    leaseTtlMs: parseDuration(c.lease_ttl),
    idlePollMs: parseDuration(c.idle_poll),
    phaseTimeoutMs: parseDuration(c.phase_timeout),
    backoffMs: c.backoff.map(parseDuration),
    watchIntervalMs: parseDuration(c.watch_interval),
  };
}

export function boardEnabled(root) {
  try { return statSync(join(root, 'board')).isDirectory(); } catch { return false; }
}
