// The one path guard, plus the id validators every board path is built from.
import {
  existsSync, lstatSync, realpathSync, readFileSync, readdirSync, writeFileSync, mkdirSync, unlinkSync,
} from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute, sep } from 'node:path';

export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
export const REQUEST_ID_RE = /^\d{12}-[a-z0-9]{6}$/;
export const WORKER_ID_RE = /^[a-z0-9][a-z0-9-]*-[a-z0-9]{6}$/;

// Stays inside the repo, lexically and for real (no symlinked component, no escape).
export function safePath(root, rel) {
  const abs = resolve(root, rel);
  const r = relative(resolve(root), abs);
  if (r === '' || r.startsWith('..') || isAbsolute(r)) throw new Error(`path escapes the repository: ${rel}`);
  let cur = resolve(root);
  for (const part of r.split(sep)) {
    cur = join(cur, part);
    let st;
    try { st = lstatSync(cur); } catch (e) { if (e.code === 'ENOENT') break; throw e; }
    if (st.isSymbolicLink()) throw new Error(`refusing symlinked path: ${rel}`);
  }
  let anc = abs;
  while (!existsSync(anc)) anc = dirname(anc);
  const real = relative(realpathSync(root), realpathSync(anc));
  if (real.startsWith('..') || isAbsolute(real)) throw new Error(`path escapes the repository: ${rel}`);
  return abs;
}

// A directory on disk behind the same content API a protocol write's mutate gets (see git.mjs):
// read(path) -> text | null, exists, list(dir) -> names, write, remove. Every path goes through safePath.
export function dirTree(root) {
  const at = (rel) => safePath(root, rel);
  return {
    read: (rel) => { const abs = at(rel); return existsSync(abs) ? readFileSync(abs, 'utf8') : null; },
    exists: (rel) => existsSync(at(rel)),
    list: (rel) => { const abs = at(rel); return existsSync(abs) ? readdirSync(abs).sort() : []; },
    write: (rel, text) => { const abs = at(rel); mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, text); },
    remove: (rel) => unlinkSync(at(rel)),
  };
}
