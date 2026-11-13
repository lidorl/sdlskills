import { createInterface } from 'node:readline';

/**
 * Line-at-a-time prompts that survive piped input. readline's own question()
 * drops lines that arrive before it is called and never settles when input
 * ends, so lines are queued and a closed input answers `null`.
 */
export function makePrompter(input, output) {
  const rl = createInterface({ input, output, terminal: Boolean(input.isTTY) });
  const queue = [];
  let waiter = null;
  let closed = false;
  rl.on('line', (line) => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(line);
    } else queue.push(line);
  });
  rl.on('close', () => {
    closed = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(null);
    }
  });
  const ask = (question) =>
    new Promise((resolveAnswer) => {
      if (queue.length) {
        output.write(question);
        return resolveAnswer(queue.shift());
      }
      if (closed) return resolveAnswer(null);
      waiter = resolveAnswer;
      rl.setPrompt(question);
      rl.prompt();
    });
  return { ask, close: () => rl.close() };
}
