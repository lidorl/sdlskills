// Secret redaction for error excerpts that end up in the shared board repo.
// Errs on the side of redacting: a leaked token in a shared repo is the failure to prevent.

const R = '[REDACTED]';
const PK = '[A-Z0-9 ]{0,32}PRIVATE KEY(?: BLOCK)?';

// Whole-match replacement. Every pattern is linear-time: no unbounded quantifier is
// re-scanned from each word boundary. Order matters.
const WHOLE = [
  // PEM block; an unterminated BEGIN runs to the end of the text (one match, no rescans).
  new RegExp(`-----BEGIN ${PK}-----[\\s\\S]*?(?:-----END ${PK}-----|$)`, 'g'),
  // stray END (BEGIN cut off by the line window): from the start of the text.
  new RegExp(`^[\\s\\S]*?-----END ${PK}-----`, 'g'),
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bnpm_[A-Za-z0-9]{36}/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\b[sr]k_live_[0-9A-Za-z]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/g,
  /\bxox[abposr]-[A-Za-z0-9-]+/g,
  /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
];

const MAX_LINE = 2000;
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

  // Credential headers: keep the header name and scheme word, hide the rest of the line.
  out = out.replace(
    /\b((?:Proxy-)?Authorization["']?[ \t]{0,8}[:=][ \t]{0,8}(?:[A-Za-z][\w-]{0,31}[ \t]+(?=\S))?)[^\n]+/gi,
    `$1${R}`,
  );
  out = out.replace(/\b((?:Set-)?Cookie["']?[ \t]{0,8}:[ \t]{0,8})[^\n]+/gi, `$1${R}`);
  out = out.replace(/(\bBearer[ \t]+)[A-Za-z0-9._~+/=-]+/gi, `$1${R}`);
  // URL userinfo: everything after :// up to the LAST @ of the token (bounded).
  out = out.replace(/([a-z][a-z0-9+.-]{0,31}:\/\/)\S{1,256}@/gi, `$1${R}@`);
  out = out.replace(
    /(\b[\w.-]{0,64}(?:password|passwd|secret|api[_-]?key|token)[\w.-]{0,64}["']?[ \t]{0,8}[=:][ \t]{0,8})("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|(?:[^\s\\]|\\.|\\)+)/gi,
    (m, key, val) => {
      if (val === R) return m;
      const q = val[0] === '"' || val[0] === "'" ? val[0] : '';
      return q && val.length > 1 && val.endsWith(q) ? `${key}${q}${R}${q}` : `${key}${R}`;
    },
  );
  return out;
}

export function safeExcerpt(text, { maxLines = 50, env = process.env } = {}) {
  try {
    const tail = String(text).split('\n').slice(-maxLines).join('\n');
    const lines = redact(tail, env).split('\n').map((l) => (l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)} …[truncated]` : l));
    return { text: lines.join('\n'), withheld: false };
  } catch {
    return { text: 'excerpt withheld: redaction failed', withheld: true };
  }
}
