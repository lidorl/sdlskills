import { createInterface, emitKeypressEvents } from 'node:readline';
import { makePrompter } from './prompter.mjs';
import { colorEnabled, makeStyle } from './style.mjs';

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const cursorUp = (n) => `\x1b[${n}A`;
const CLEAR_DOWN = '\x1b[0J';

/** "1", "1 or 2", "1, 2 or 3" */
const numberList = (n) => {
  const nums = Array.from({ length: n }, (_, i) => String(i + 1));
  return n < 2 ? nums[0] : `${nums.slice(0, -1).join(', ')} or ${nums.at(-1)}`;
};

/**
 * Terminal interaction with no dependencies. In a real terminal: arrow-key
 * menus and Tab completion. Anywhere else (pipes, CI, tests): numbered choices
 * and plain lines, so scripted use keeps working.
 *
 * choices: [{ label, value, key?, aliases?, hint? }]
 */
export function createUi({ input, output, env = process.env }) {
  const interactive = Boolean(input.isTTY && output.isTTY && typeof input.setRawMode === 'function');
  const style = makeStyle(colorEnabled(output, env));
  const say = (text = '') => output.write(text + '\n');
  const queued = interactive ? null : makePrompter(input, output);

  /** One line of input; resolves null if input closes. `completer` enables Tab completion. */
  const ask = (question, { completer } = {}) => {
    if (!interactive) return queued.ask(question);
    return new Promise((resolve) => {
      const rl = createInterface({ input, output, terminal: true, completer });
      let answered = false;
      rl.once('close', () => {
        if (!answered) resolve(null);
      });
      rl.question(question, (answer) => {
        answered = true;
        rl.close();
        resolve(answer);
      });
    });
  };

  const selectWithKeys = ({ message, choices, initial = 0 }) =>
    new Promise((resolve) => {
      let index = initial;
      let drawn = 0;
      const draw = () => {
        const lines = [
          `${style.cyan('?')} ${style.bold(message)}`,
          ...choices.map((c, i) => {
            const hint = c.hint ? ` ${style.dim(c.hint)}` : '';
            return i === index ? `${style.cyan('❯')} ${style.cyan(c.label)}${hint}` : `  ${c.label}${hint}`;
          }),
        ];
        if (drawn) output.write(cursorUp(drawn) + CLEAR_DOWN);
        output.write(lines.join('\n') + '\n');
        drawn = lines.length;
      };
      const finish = (value) => {
        input.off('keypress', onKey);
        input.setRawMode(false);
        input.pause();
        output.write(cursorUp(drawn) + CLEAR_DOWN + SHOW_CURSOR);
        if (value !== null) {
          const label = choices.find((c) => c.value === value).label;
          say(`${style.green('✔')} ${style.bold(message)} ${style.cyan(label)}`);
        }
        resolve(value);
      };
      const onKey = (str, key = {}) => {
        if ((key.ctrl && (key.name === 'c' || key.name === 'd')) || key.name === 'escape') return finish(null);
        if (key.name === 'return' || key.name === 'enter') return finish(choices[index].value);
        if (key.name === 'up' || key.name === 'k') index = (index - 1 + choices.length) % choices.length;
        else if (key.name === 'down' || key.name === 'j') index = (index + 1) % choices.length;
        else if (/^[1-9]$/.test(str ?? '') && Number(str) <= choices.length) index = Number(str) - 1;
        else {
          // A choice's own key (y/n, c/a/q, ...) picks it at once, like the old typed prompts.
          const hit = key.ctrl || key.meta ? undefined : choices.find((c) => c.key && c.key === str?.toLowerCase());
          if (hit) return finish(hit.value);
          return;
        }
        draw();
      };
      emitKeypressEvents(input);
      input.setRawMode(true);
      input.resume();
      output.write(HIDE_CURSOR);
      input.on('keypress', onKey);
      draw();
    });

  const selectTyped = async ({ message, choices, initial }) => {
    say(message);
    choices.forEach((c, i) => say(`  ${i + 1}) ${c.label}`));
    for (;;) {
      const answer = await queued.ask(`Choose ${numberList(choices.length)}: `);
      if (answer === null) return null;
      const a = answer.trim().toLowerCase();
      if (a === '' && initial !== undefined) return choices[initial].value;
      const hit = choices.find(
        (c, i) =>
          a !== '' &&
          (a === String(i + 1) || a === c.key || a === String(c.value).toLowerCase() || a === c.label.toLowerCase() || c.aliases?.includes(a)),
      );
      if (hit) return hit.value;
      say(`Please type ${numberList(choices.length)}.`);
    }
  };

  /** Picks one of `choices`; resolves its `value`, or null if cancelled or input closes. */
  const select = (options) => (interactive ? selectWithKeys(options) : selectTyped(options));

  return { interactive, style, say, ask, select, close: () => queued?.close() };
}
