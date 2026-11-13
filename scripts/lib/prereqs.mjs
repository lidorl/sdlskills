import { execFileSync } from 'node:child_process';

const NODE_MIN_MAJOR = 20;
const SAFE_TOKEN = /^[A-Za-z0-9@._:/=-]+$/;

/**
 * On Windows, npm installs CLIs as `.cmd` shims, which execFile cannot launch
 * without a shell. The whole command goes in as one string so Node does not
 * warn about passing an args array together with `shell: true`.
 */
function invoke(cmd, args, { exec = execFileSync, platform = process.platform, stdio = 'ignore' } = {}) {
  if (platform === 'win32') {
    const parts = [cmd, ...args];
    // The shell parses this string, so only plain tokens may reach it.
    if (!parts.every((p) => SAFE_TOKEN.test(p))) throw new Error(`unsafe command for shell: ${parts.join(' ')}`);
    return exec(parts.join(' '), { shell: true, stdio });
  }
  return exec(cmd, args, { stdio });
}

/** True when `cmd --version` runs. */
export function commandAvailable(cmd, opts) {
  try {
    invoke(cmd, ['--version'], opts);
    return true;
  } catch {
    return false;
  }
}

/** Runs `cmd args...`; throws if it fails. */
export function runCli(cmd, args, opts) {
  invoke(cmd, args, opts);
}

/**
 * @returns {{ id: 'node'|'git'|'tool-cli'|'gh', label: string, ok: boolean, required: boolean, fix: string }[]}
 */
export function checkPrereqs({ layout, nodeVersion = process.versions.node, available = commandAvailable }) {
  const major = Number(String(nodeVersion).split('.')[0]);
  return [
    {
      id: 'node',
      label: `Node ${NODE_MIN_MAJOR} or newer (found ${nodeVersion})`,
      ok: major >= NODE_MIN_MAJOR,
      required: true,
      fix: `Install Node ${NODE_MIN_MAJOR} or newer from https://nodejs.org`,
    },
    {
      id: 'git',
      label: 'git',
      ok: available('git'),
      required: true,
      fix: 'Install git from https://git-scm.com',
    },
    {
      id: 'tool-cli',
      label: `${layout.toolName} CLI (\`${layout.plugin.cli}\`)`,
      ok: available(layout.plugin.cli),
      required: layout.cliRequired,
      fix: layout.cliInstallHint,
    },
    {
      id: 'gh',
      label: 'GitHub CLI (`gh`)',
      ok: available('gh'),
      required: false,
      fix: 'Install the GitHub CLI from https://cli.github.com (needed at close-out to verify merged PRs)',
    },
  ];
}
