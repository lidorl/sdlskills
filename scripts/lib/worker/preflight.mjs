// Checks run before every claim. 'worker' problems are posted as a worker error and the worker idles;
// 'fatal' problems stop the worker without writing to the board (a retired or unregistered worker must not write).
import { spawnSync } from 'node:child_process';
import { readWorker } from '../board/registry.mjs';

export function realDeps() {
  return {
    gh: {
      installed: () => !spawnSync('gh', ['--version'], { stdio: 'ignore' }).error,
      authOk: () => spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' }).status === 0,
    },
    which: (cmd) => spawnSync('sh', ['-c', 'command -v "$1"', 'sh', String(cmd)], { stdio: 'ignore' }).status === 0,
  };
}

export function preflight({ home, cfg, root, gh, which }) {
  const fatal = (problem) => ({ ok: false, problem, kind: 'fatal' });
  const worker = (problem) => ({ ok: false, problem, kind: 'worker' });
  const reg = readWorker(root, cfg.id);
  if (!reg) return fatal(`worker ${cfg.id} is not registered on the board`);
  if (reg.retired_at) return fatal(`worker ${cfg.id} is retired`);
  for (const field of ['agent', 'model']) {
    if (cfg[field] !== reg[field]) {
      return fatal(`config and registry disagree: ${field} is ${cfg[field]} locally but ${reg[field]} on the board`);
    }
  }
  if (gh.installed && !gh.installed()) return worker('gh is not installed; install the GitHub CLI');
  if (!gh.authOk()) return worker('gh is not logged in; run `gh auth login`');
  const cmd = cfg.agent_cmd ?? cfg.agent;
  if (!which(cmd)) return worker(`agent CLI ${cmd} not found on PATH`);
  return { ok: true };
}
