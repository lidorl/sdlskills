// The run lock's file operations (Ruling P2-19). A lock is never empty: it is created whole, by linking a
// fully written temp file into place, and holds "<pid> <token>\n" with a random token per start, so its
// content identifies one start and can never recur. Policy (who may run, who may take over) is in cli.mjs.
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, fstatSync, linkSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

// A marker older than this was left by a start that died: taking over a lock takes milliseconds.
export const ABANDONED_MS = 10_000;

export const newToken = () => BigInt(`0x${randomBytes(8).toString('hex')}`).toString(36).padStart(12, '0').slice(-12);
export const lockContent = (pid, token) => `${pid} ${token}\n`;

// "<pid> <token>\n" (or a legacy "<pid>\n") -> the pid; null for an empty or malformed lock.
export function lockPid(text) {
  const m = /^(\d+)(?: [0-9a-z]+)?\n?$/.exec(text);
  const n = m ? Number(m[1]) : 0;
  return n > 0 ? n : null;
}

// The lock as one consistent read (content and stat of the same inode); null when there is none.
export function readLock(file) {
  let fd;
  try { fd = openSync(file, 'r'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try {
    const st = fstatSync(fd);
    return { text: readFileSync(fd, 'utf8'), dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs };
  } finally { closeSync(fd); }
}

// What makes a lock this lock: its content when it names a pid (the token makes it unique); the inode and
// mtime of an empty or malformed one, which only legacy code or corruption leaves.
const identity = (lock) => (lockPid(lock.text) ? `content:${lock.text}` : `stat:${lock.dev}:${lock.ino}:${lock.mtimeMs}`);
export const sameLock = (a, b) => !!a && !!b && identity(a) === identity(b);
const keyOf = (lock) => createHash('sha1').update(identity(lock)).digest('hex').slice(0, 12);

const temp = (file, pid) => `${file}.tmp-${pid}-${randomBytes(4).toString('hex')}`;

// Create the lock holding `content`, atomically. -> false when a lock already exists.
export function createLock(file, content, pid) {
  const tmp = temp(file, pid);
  writeFileSync(tmp, content, { flag: 'wx' });
  try {
    linkSync(tmp, file);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  } finally { rmSync(tmp, { force: true }); }
}

// Replace the lock's content atomically. Only its holder does this (the --detach handover).
export function replaceLock(file, content, pid) {
  const tmp = temp(file, pid);
  writeFileSync(tmp, content, { flag: 'wx' });
  try { renameSync(tmp, file); } catch (e) { rmSync(tmp, { force: true }); throw e; }
}

const markerPrefix = (file) => `${basename(file)}.takeover-`;
const ageMs = (f) => { try { return Date.now() - statSync(f).mtimeMs; } catch { return null; } };

// Replace the lock `seen`, judged stale, with `content` (or remove it when no content is given), unless it
// changed meanwhile. Replacing is one rename, so no other start can create a lock in between. Only the holder
// of the stale lock's takeover marker may replace or remove it. Markers are numbered: one older than
// ABANDONED_MS belongs to a start that died, and the next number is tried instead, so no marker is ever
// removed while someone may still need it (a marker goes only when its holder is done, or once the lock it
// was for is gone for good: see clearOldMarkers).
// -> 'replaced' | 'removed' | 'changed' (the lock is no longer `seen`) | 'busy' (another start is taking it over)
export function takeOver(file, seen, pid, content) {
  const key = keyOf(seen);
  const tmp = content === undefined ? null : temp(file, pid);
  if (tmp) writeFileSync(tmp, content, { flag: 'wx' });
  try {
    for (let n = 0; ; n++) {
      const marker = `${file}.takeover-${key}-${n}`;
      try {
        writeFileSync(marker, `${pid}\n`, { flag: 'wx' });
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        if (ageMs(marker) > ABANDONED_MS) continue;
        return 'busy';
      }
      try {
        if (!sameLock(readLock(file), seen)) return 'changed';
        if (!tmp) { rmSync(file); return 'removed'; }
        renameSync(tmp, file);
        return 'replaced';
      } finally { rmSync(marker, { force: true }); }
    }
  } finally { if (tmp) rmSync(tmp, { force: true }); }
}

// Remove the takeover markers left for locks other than `own`, which the caller holds. A lock's identity never
// recurs, so a marker for any other lock can never be needed again.
export function clearOldMarkers(file, own) {
  const keep = `${markerPrefix(file)}${keyOf(own)}-`;
  for (const name of readdirSync(dirname(file))) {
    if (name.startsWith(markerPrefix(file)) && !name.startsWith(keep)) rmSync(join(dirname(file), name), { force: true });
  }
}

// The marker for `lock` with number `n` (tests seed abandoned markers with it).
export const markerFor = (file, lock, n = 0) => `${file}.takeover-${keyOf(lock)}-${n}`;
