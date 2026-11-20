// Secret redaction for error excerpts that end up in the shared board repo.
// Errs on the side of redacting: a leaked token in a shared repo is the failure to prevent.

const R = '[REDACTED]';
const PK = '[A-Z0-9 ]*PRIVATE KEY';

// Whole-match replacement. Order matters: PEM blocks first, then a dangling BEGIN
// (through end of text), then a stray END (from start of text, since the window cut BEGIN).
const WHOLE = [
  new RegExp(`-----BEGIN ${PK}-----[\\s\\S]*?-----END ${PK}-----`, 'g'),
  new RegExp(`-----BEGIN ${PK}-----[\\s\\S]*$`, 'g'),
  new RegExp(`^[\\s\\S]*?-----END ${PK}-----`, 'g'),
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-[A-Za-z0-9]{32,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function redact(text, env = process.env) {
  let out = String(text);

  // Values of sensitive env vars, longest first so a value containing another is fully covered.
  const values = Object.entries(env)
    .filter(([name, v]) => /TOKEN|SECRET|KEY|PASSWORD/i.test(name) && typeof v === 'string' && v.length >= 6)
    .map(([, v]) => v)
    .sort((x, y) => y.length - x.length);
  for (const v of new Set(values)) out = out.replace(new RegExp(escapeRe(v), 'g'), R);

  for (const re of WHOLE) out = out.replace(re, R);

  out = out.replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${R}`);
  out = out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${R}@`);
  out = out.replace(
    /(\b[\w.-]*(?:password|passwd|secret|api[_-]?key|token)[\w.-]*["']?\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"',;]+)/gi,
    (m, key, val) => (val === R ? m : `${key}${R}`),
  );
  return out;
}

export function safeExcerpt(text, { maxLines = 50, env = process.env } = {}) {
  try {
    const tail = String(text).split('\n').slice(-maxLines).join('\n');
    return { text: redact(tail, env), withheld: false };
  } catch {
    return { text: 'excerpt withheld: redaction failed', withheld: true };
  }
}
