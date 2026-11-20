#!/usr/bin/env node
// sdlc: client for the work board (status, watch, inbox, answer; claim/report/release for interactive sessions).
import { execFileSync } from 'node:child_process';
import { run } from './lib/board/cli.mjs';
import { isEntryPoint } from './lib/is-entry-point.mjs';

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

// The signed-in GitHub user, falling back to git config when gh is unavailable.
export function whoami() {
  try {
    const u = JSON.parse(sh('gh', ['api', 'user']));
    const email = u.email || `${u.id}+${u.login}@users.noreply.github.com`;
    return { login: u.login, name: u.name || u.login, email };
  } catch {
    const name = sh('git', ['config', 'user.name']);
    const email = sh('git', ['config', 'user.email']);
    return { login: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), name, email };
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
