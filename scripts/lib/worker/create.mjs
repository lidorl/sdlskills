// `sdlc worker create`: resolve the owner, probe the agent, build the home, register on the board.
// Any failure after the home exists removes it again: no unregistered home is left behind.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardWrite } from '../board/git.mjs';
import { workerYaml } from '../board/registry.mjs';
import { DEFAULT_CONFIG_YAML } from '../board/config.mjs';
import { WORKER_ID_RE } from '../board/safe-path.mjs';
import { agentCommand, runAgent, RUN_DIR } from './agent.mjs';
import { workerHome, writeConfig, agentSettings, installTrailerHook, excludeRunDir } from './home.mjs';

export class CreateError extends Error {}

const MAX_TRIES = 5;
const PROBE_PROMPT = 'Reply with OK.';
const PROBE_TIMEOUT_MS = 60_000;
const LOGIN_RE = /^[a-z0-9-]+$/;
const KIT_SKILL = { claude: '.claude/skills/select-next-task/SKILL.md', copilot: '.github/skills/select-next-task/SKILL.md' };

export function newWorkerId(login, rand = Math.random) {
  let suffix = '';
  for (let i = 0; i < 6; i++) suffix += Math.floor(rand() * 36).toString(36);
  return `${login}-${suffix}`;
}

// gh.api(path) -> parsed JSON object. GitHub logins are case-insensitive, so the login is lowercased.
export function resolveOwner(gh) {
  const u = gh.api('user');
  const login = String(u?.login ?? '').toLowerCase();
  if (!LOGIN_RE.test(login)) throw new CreateError(`cannot use GitHub login "${u?.login}" in a worker id`);
  const email = u.email || (u.id != null ? `${u.id}+${login}@users.noreply.github.com` : `${login}@users.noreply.github.com`);
  return { login, name: u.name || login, email };
}

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const firstLine = (e) => String(e?.stderr || e?.message || e).split('\n').find((l) => l.trim()) ?? String(e);
const realNpm = (args, cwd) => execFileSync('npm', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// Installs the meta clone's dependencies (node_modules is gitignored, so a clone has none): `npm ci`, or
// `npm install` without a lockfile. A meta repo with no package.json has nothing to install. -> the failure
// message, or null.
export function installMetaDeps(meta, npm = realNpm) {
  if (!existsSync(join(meta, 'package.json'))) return null;
  const args = existsSync(join(meta, 'package-lock.json')) ? ['ci'] : ['install'];
  try { npm(args, meta); return null; } catch (e) {
    const tail = String(e?.stderr || e?.message || e).split('\n').filter((l) => l.trim()).slice(-10).join('\n');
    return `\`npm ${args.join(' ')}\` failed in ${meta}:\n${tail}`;
  }
}

const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

async function probeAgent(cfg) {
  const dir = mkdtempSync(join(tmpdir(), 'sdlc-probe-'));
  try {
    writeFileSync(join(dir, 'agent-settings.json'), JSON.stringify(agentSettings()));
    const { cmd, args, env } = agentCommand(cfg, PROBE_PROMPT, dir);
    const r = await runAgent({ cmd, args, env, cwd: dir, timeoutMs: PROBE_TIMEOUT_MS, logPath: join(dir, 'probe.log') });
    if (r.spawnError) throw new CreateError(`agent/model probe failed: ${r.spawnError.message}`);
    if (r.timedOut) throw new CreateError('agent/model probe failed: timed out after 60s');
    if (r.exitCode !== 0) {
      throw new CreateError(`agent/model probe failed: exit ${r.exitCode ?? r.signal}${r.stderrTail ? `\n${r.stderrTail}` : ''}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Registers `id` as a protocol write. Returns 'ok' or 'taken'; throws on any other failure.
async function register(meta, { id, owner, name, host, agent, model, stamp }) {
  const yaml = workerYaml({ id, owner: owner.login, name, host, agent, model, created_at: stamp });
  const file = `board/workers/${id}.yml`;
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    let taken = false;
    const r = await boardWrite(meta, {
      kind: 'register', subject: id, trailers: { worker: id }, identity: { name: owner.name, email: owner.email },
      onReject: 'restart', commitFromHead: true,
      mutate: (tree) => {
        if (tree.exists(file)) { taken = true; return; }
        if (!tree.exists('board')) {
          tree.write('board/workers/.gitkeep', '');
          tree.write('board/requests/.gitkeep', '');
          tree.write('board/config.yml', DEFAULT_CONFIG_YAML);
        }
        tree.write(file, yaml);
      },
      validate: (view) => view.read(file) === yaml,
    });
    if (r.ok) return 'ok';
    if (r.reason === 'nothing-to-do' && taken) return 'taken';
    if (r.reason === 'lost-race') continue;
    throw new CreateError(`registration failed: ${r.reason}`);
  }
  throw new CreateError('registration failed: lost the race to push 5 times');
}

export async function createWorker({
  metaUrl, agent, model, name, agentCmd, cliArgs = [], probe = true, gh, env = process.env, now = () => new Date(),
  host = hostname(), rand = Math.random, npm = realNpm,
}) {
  if (!metaUrl) throw new CreateError('meta repo url is required');
  if (String(metaUrl).startsWith('-')) throw new CreateError(`meta repo url must not start with "-": ${metaUrl}`);
  if (!KIT_SKILL[agent]) throw new CreateError(`unknown agent "${agent}" (claude or copilot)`);
  if (!model) throw new CreateError('model is required');
  const owner = resolveOwner(gh);
  const probeCfg = { id: 'probe', agent, model, cli_args: cliArgs, ...(agentCmd ? { agent_cmd: agentCmd } : {}) };
  if (probe) await probeAgent(probeCfg);

  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const id = newWorkerId(owner.login, rand);
    if (!WORKER_ID_RE.test(id)) throw new CreateError(`invalid worker id: ${id}`);
    const home = workerHome(id, env);
    if (existsSync(home)) continue;
    try {
      mkdirSync(home, { recursive: true });
      const meta = join(home, 'meta');
      try { git(home, ['clone', '-q', '--', metaUrl, 'meta']); } catch (e) { throw new CreateError(`cannot clone ${metaUrl}: ${firstLine(e)}`); }
      const npmFailure = installMetaDeps(meta, npm);
      if (npmFailure) throw new CreateError(npmFailure);
      const skill = KIT_SKILL[agent];
      if (!existsSync(join(meta, skill))) throw new CreateError(`meta repo has no kit for ${agent}: missing ${skill}`);
      git(meta, ['config', 'user.name', owner.name]);
      git(meta, ['config', 'user.email', owner.email]);
      installTrailerHook(meta, id);
      excludeRunDir(meta, RUN_DIR);
      const cfgName = name || id;
      writeConfig(home, {
        id, owner: owner.login, meta_url: metaUrl, agent, model, cli_args: cliArgs, name: cfgName,
        author: { name: owner.name, email: owner.email }, ...(agentCmd ? { agent_cmd: agentCmd } : {}),
      });
      writeFileSync(join(home, 'agent-settings.json'), JSON.stringify(agentSettings(), null, 2) + '\n');
      const when = typeof now === 'function' ? now() : now;
      const res = await register(meta, { id, owner, name: cfgName, host, agent, model, stamp: iso(when) });
      if (res === 'ok') return { id, home };
    } catch (e) {
      rmSync(home, { recursive: true, force: true });
      throw e;
    }
    rmSync(home, { recursive: true, force: true }); // 'taken': new suffix
  }
  throw new CreateError(`could not find a free worker id after ${MAX_TRIES} tries`);
}
