import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * True when the module at `metaUrl` (pass `import.meta.url`) is the script
 * Node was launched with, so `main()` runs on `node script.mjs` but not on
 * `import`.
 *
 * Don't compare `import.meta.url` to `file://${process.argv[1]}`: that never
 * matches on Windows (`file:///C:/x` vs `C:\x`), and also fails for paths with
 * spaces or symlinks (macOS `/var` -> `/private/var`), so the script silently
 * does nothing. Compare real filesystem paths instead.
 */
export function isEntryPoint(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
