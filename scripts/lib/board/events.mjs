import { execFileSync } from 'node:child_process';

export const EVENT_KINDS = [
  'register', 'config', 'start', 'stop', 'crash', 'claim', 'renew', 'release',
  'takeover', 'report', 'request', 'answer', 'apply', 'withdraw', 'retire',
];

// Trailer order is fixed: [git key, trailers field].
const TRAILERS = [
  ['Worker', 'worker'], ['Sdlc-Event', 'kind'], ['Effort', 'effort'], ['Request', 'request'],
  ['Phase', 'phase'], ['Replaces', 'replaces'], ['Answered-by', 'answeredBy'],
];

export function formatMessage({ kind, subject, trailers = {} }) {
  if (!EVENT_KINDS.includes(kind)) throw new Error(`unknown event kind ${JSON.stringify(kind)}`);
  const values = { ...trailers, kind };
  const lines = TRAILERS
    .filter(([, field]) => values[field] !== null && values[field] !== undefined)
    .map(([key, field]) => `${key}: ${values[field]}`);
  return `board(${kind}): ${subject}\n\n${lines.join('\n')}\n`;
}

export function parseLog(root, { ref = 'origin/main', limit = 2000, sinceSha } = {}) {
  const range = sinceSha ? `${sinceSha}..${ref}` : ref;
  const out = execFileSync('git', [
    'log', range, '-n', String(limit),
    '--format=%H%x00%an%x00%aI%x00%s%x00%(trailers:unfold,only)%x1e',
  ], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const events = [];
  for (const rec of out.split('\x1e')) {
    if (!rec.trim()) continue;
    const [sha, author, at, rawSubject, trailerText = ''] = rec.replace(/^\n/, '').split('\0');
    const t = {};
    for (const line of trailerText.split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) t[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    if (!t['Sdlc-Event']) continue;
    const kind = t['Sdlc-Event'];
    const prefix = `board(${kind}): `;
    events.push({
      sha, author, at: new Date(at), kind,
      subject: rawSubject.startsWith(prefix) ? rawSubject.slice(prefix.length) : rawSubject,
      worker: t.Worker ?? null, effort: t.Effort ?? null, request: t.Request ?? null,
      phase: t.Phase ?? null, replaces: t.Replaces ?? null, answeredBy: t['Answered-by'] ?? null,
    });
  }
  return events;
}
