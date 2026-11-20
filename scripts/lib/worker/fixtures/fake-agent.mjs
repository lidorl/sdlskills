// Stand-in for a headless agent CLI. FAKE_AGENT_SCRIPT points at JSON:
// { writes: {relPath: content}, exec: [[cwdRel, cmd, ...args]], result: object | null, exitCode, sleepMs, stderr,
//   pidFile, grandchildPidFile } — the pid files (written after `writes`) let a test check the process group is killed.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';

const script = JSON.parse(readFileSync(process.env.FAKE_AGENT_SCRIPT, 'utf8'));

for (const [rel, content] of Object.entries(script.writes ?? {})) {
  const file = resolve(process.cwd(), rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}
for (const [cwd, cmd, ...args] of script.exec ?? []) {
  execFileSync(cmd, args, { cwd: resolve(process.cwd(), cwd), stdio: 'ignore' });
}
if (script.grandchildPidFile) {
  const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  writeFileSync(script.grandchildPidFile, String(g.pid));
}
if (script.pidFile) writeFileSync(script.pidFile, String(process.pid));
if (script.sleepMs) await new Promise((r) => setTimeout(r, script.sleepMs));
if (script.result != null && process.env.SDLC_RESULT_FILE) {
  writeFileSync(process.env.SDLC_RESULT_FILE, JSON.stringify(script.result));
}
if (script.stderr) process.stderr.write(script.stderr.endsWith('\n') ? script.stderr : `${script.stderr}\n`);
process.exit(script.exitCode ?? 0);
