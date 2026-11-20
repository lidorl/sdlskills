// Stand-in for a headless agent CLI. FAKE_AGENT_SCRIPT points at JSON:
// { writes: {relPath: content}, result: object | null, exitCode, sleepMs, stderr }
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const script = JSON.parse(readFileSync(process.env.FAKE_AGENT_SCRIPT, 'utf8'));

for (const [rel, content] of Object.entries(script.writes ?? {})) {
  const file = resolve(process.cwd(), rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}
if (script.sleepMs) await new Promise((r) => setTimeout(r, script.sleepMs));
if (script.result != null && process.env.SDLC_RESULT_FILE) {
  writeFileSync(process.env.SDLC_RESULT_FILE, JSON.stringify(script.result));
}
if (script.stderr) process.stderr.write(script.stderr.endsWith('\n') ? script.stderr : `${script.stderr}\n`);
process.exit(script.exitCode ?? 0);
