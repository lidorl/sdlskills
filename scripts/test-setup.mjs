// Test harness for the kit's own `npm test` (loaded with --import; not vendored to adopters).
// On macOS /usr/bin/git is an xcrun shim that costs several times a real git call, and the suites make
// thousands of them: put the real git's directory first on PATH. A no-op where xcrun is absent.
import { execFileSync } from 'node:child_process';
import { delimiter, dirname } from 'node:path';

if (process.platform === 'darwin' && !process.env.SDLC_TEST_GIT_PATH) {
  try {
    const git = execFileSync('xcrun', ['-f', 'git'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (git) {
      process.env.SDLC_TEST_GIT_PATH = dirname(git);
      process.env.PATH = `${dirname(git)}${delimiter}${process.env.PATH ?? ''}`;
    }
  } catch { /* no xcrun: keep PATH as it is */ }
}
