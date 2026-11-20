import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const roots = ['lib/board', 'lib/worker', 'sdlc.mjs'].map((p) => join(scripts, p)).filter(existsSync);

function sources(p) {
  if (statSync(p).isDirectory()) return readdirSync(p).flatMap((n) => sources(join(p, n)));
  return p.endsWith('.mjs') && !p.endsWith('.test.mjs') ? [p] : [];
}

const INVOKES_PUSH = /'push'|"push"|git push/;
const FORCES = /--force|--force-with-lease|['"]-f['"]|\s-f\s|\+refs\/|\+HEAD|['"]\+[\w/]/;

test('no source line that pushes also forces', () => {
  const offenders = [];
  for (const file of roots.flatMap(sources)) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (INVOKES_PUSH.test(line) && FORCES.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});
