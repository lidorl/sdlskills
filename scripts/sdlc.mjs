#!/usr/bin/env node
// sdlc: client for the work board (status, watch, inbox, answer; claim/report/release for interactive sessions).
import { execFileSync } from 'node:child_process';
import { run } from './lib/board/cli.mjs';
import { isEntryPoint } from './lib/is-entry-point.mjs';

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

// The signed-in GitHub user. Commits and answers are recorded under this login, so there is no fallback.
export function whoami() {
  try {
    const u = JSON.parse(sh('gh', ['api', 'user']));
    if (!u.login) throw new Error('no login');
    return { login: u.login, name: u.name || u.login, email: u.email || `${u.id}+${u.login}@users.noreply.github.com` };
  } catch {
    throw new Error('cannot determine your GitHub login: run `gh auth login`, then try again');
  }
}

if (isEntryPoint(import.meta.url)) {
  const code = await run(process.argv.slice(2), {
    cwd: process.cwd(),
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    now: () => new Date(),
    whoami,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  process.exitCode = code;
}
