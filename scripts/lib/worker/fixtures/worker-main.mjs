// Stand-in for scripts/sdlc.mjs in the detach test: `worker <args>` with gh and the agent CLI faked as present.
import { fileURLToPath } from 'node:url';
import { runWorker } from '../cli.mjs';

const argv = process.argv.slice(2);
process.exitCode = await runWorker(argv[0] === 'worker' ? argv.slice(1) : argv, {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  scriptPath: fileURLToPath(import.meta.url),
  loop: { gh: { installed: () => true, authOk: () => true }, which: () => true },
});
