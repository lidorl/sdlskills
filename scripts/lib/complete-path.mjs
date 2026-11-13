import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * readline completer for folder paths: [completions, the text being completed].
 * Only folders are offered, with a trailing "/". `~` stays as typed.
 */
export function completePath(line, { cwd = process.cwd(), home = homedir() } = {}) {
  const slash = Math.max(line.lastIndexOf('/'), line.lastIndexOf('\\'));
  const dirPart = line.slice(0, slash + 1);
  const base = line.slice(slash + 1);
  const expanded = dirPart === '~/' || dirPart.startsWith('~/') ? join(home, dirPart.slice(2)) : dirPart;
  try {
    const hits = readdirSync(resolve(cwd, expanded || '.'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith(base) && (base.startsWith('.') || !e.name.startsWith('.')))
      .map((e) => `${dirPart}${e.name}/`)
      .sort();
    return [hits, line];
  } catch {
    return [[], line];
  }
}
