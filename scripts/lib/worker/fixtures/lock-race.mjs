// One contender in the run-lock race test: `node lock-race.mjs worker start <id> <home> <startAtMs> <holdMs>`.
// A winner prints `WIN <stale pid>`. The argv makes `ps` show it as `worker start <id>`, so a winner holding the
// lock counts as that worker.
import { lockRun, realProcCommand } from '../cli.mjs';
import { isAlive } from '../home.mjs';

const [, , , , id, home, startAt, hold] = process.argv;
while (Date.now() < Number(startAt)) { /* line up with the other contenders */ }
try {
  const { stalePid } = lockRun(home, id, { env: {}, pid: process.pid, isAlive, procCommand: realProcCommand });
  process.stdout.write(`WIN ${stalePid}\n`);
  setTimeout(() => {}, Number(hold));
} catch (e) {
  process.stdout.write(`REFUSE ${e.message}\n`);
}
