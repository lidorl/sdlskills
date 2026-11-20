// A worker's persistent home: ${SDLC_HOME:-~/.sdlc}/workers/<id>/ with config, state, pid and the trailer hook.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { WORKER_ID_RE } from '../board/safe-path.mjs';

export function sdlcHome(env = process.env) {
  return env.SDLC_HOME || join(env.HOME || homedir(), '.sdlc');
}

function checkId(id) {
  if (typeof id !== 'string' || !WORKER_ID_RE.test(id)) throw new Error(`invalid worker id: ${id}`);
  return id;
}

export function workerHome(id, env = process.env) {
  return join(sdlcHome(env), 'workers', checkId(id));
}

// 2-space JSON with a trailing newline, written atomically.
function writeJson(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  renameSync(tmp, file);
}

export const readConfig = (home) => JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
export const writeConfig = (home, cfg) => writeJson(join(home, 'config.json'), cfg);

const STATE_DEFAULTS = { clean_stop: true, failures: 0, backoff_until: null };

export function readState(home) {
  const file = join(home, 'state.json');
  if (!existsSync(file)) return { ...STATE_DEFAULTS };
  return { ...STATE_DEFAULTS, ...JSON.parse(readFileSync(file, 'utf8')) };
}

export function writeState(home, patch) {
  writeJson(join(home, 'state.json'), { ...readState(home), ...patch });
}

export function writePid(home, pid) {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'worker.pid'), `${pid}\n`);
}

export function readPid(home) {
  try {
    const n = Number.parseInt(readFileSync(join(home, 'worker.pid'), 'utf8').trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export function clearPid(home) {
  try { unlinkSync(join(home, 'worker.pid')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function agentSettings() {
  return {
    sandbox: { enabled: true, autoAllowBashIfSandboxed: true },
    permissions: { defaultMode: 'acceptEdits' },
  };
}

const MARK = '# sdlc-worker-trailer';

// Adds the Worker trailer to every commit. An existing foreign commit-msg hook is kept and runs first.
export function installTrailerHook(repoDir, workerId) {
  checkId(workerId);
  const dir = join(repoDir, '.git', 'hooks');
  const hook = join(dir, 'commit-msg');
  const kept = join(dir, 'commit-msg.orig');
  mkdirSync(dir, { recursive: true });
  if (existsSync(hook) && !readFileSync(hook, 'utf8').includes(MARK)) renameSync(hook, kept);
  const chain = existsSync(kept)
    ? '"$(dirname "$0")/commit-msg.orig" "$@" || exit $?\n'
    : '';
  const script = `#!/bin/sh\n${MARK}\n${chain}git interpret-trailers --in-place --if-exists doNothing --trailer "Worker: ${workerId}" "$1"\n`;
  writeFileSync(hook, script);
  chmodSync(hook, 0o755);
}
