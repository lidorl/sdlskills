import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { checkPrereqs } from './prereqs.mjs';
import { looksLikeCodeRepo } from './code-repo.mjs';

/**
 * Line-at-a-time prompts that survive piped input. readline's own question()
 * drops lines that arrive before it is called and never settles when input
 * ends, so lines are queued and a closed input answers `null`.
 */
function makePrompter(input, output) {
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

const expandHome = (p) => (p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? join(homedir(), p.slice(1)) : p);

/**
 * Walks a first-time user through the install: explains the meta-root, checks
 * prerequisites, picks and sanity-checks the location, shows the plan.
 *
 * @returns the absolute target directory to install into, or null if the user
 *          quit, a required prerequisite is missing, or input closed.
 */
export async function runGuide({ layout, cwd, input, output, available, nodeVersion, dryRun = false, preview }) {
  const say = (text = '') => output.write(text + '\n');
  const prompter = makePrompter(input, output);
  const { ask } = prompter;
  const stop = (why) => {
    say(`\n${why} Nothing was changed.`);
    return null;
  };

  try {
    const name = basename(cwd);
    const defaultTarget = join(dirname(cwd), `${name}-workspace`);

    say(`This installs the SDLC kit for ${layout.toolName} into your SDLC repo (the *meta-root*).`);
    say('');
    say('The meta-root is a separate folder, and git repo, that holds the process, the kit\'s skills');
    say('and the docs/ trail. It is not your code: your code repositories stay untouched and are');
    say('checked out under workspace/ when you start work.');
    say('');
    const tree = [
      [`${name}-workspace/`, '<- install here (your SDLC repo)'],
      ['├── docs/', 'feature requests, designs, plans, history'],
      [`├── ${layout.skillsDir}/`, "the kit's skills"],
      [`└── workspace/${name}/`, 'checkouts of your code repos, created later'],
    ];
    const width = Math.max(...tree.map(([left]) => left.length)) + 3;
    for (const [left, note] of tree) say(`  ${left.padEnd(width)}${note}`);
    say('');
    say(`This installer is for ${layout.toolName}. Using a different tool? Run scripts/${layout.otherInstaller} instead.`);
    say('');

    say('Prerequisites:');
    const prereqs = checkPrereqs({ layout, nodeVersion, available });
    for (const p of prereqs) {
      if (p.ok) say(`  ✓ ${p.label}`);
      else say(`  ${p.required ? '✗' : '-'} ${p.label}${p.required ? '' : ' (optional)'}: ${p.fix}`);
    }
    if (prereqs.some((p) => p.required && !p.ok)) {
      return stop('Fix the items marked ✗ above, then run this again.');
    }
    say('');

    let target;
    for (;;) {
      const answer = await ask(`Where should the SDLC repo go? [${defaultTarget}] `);
      if (answer === null) return stop('Input closed.');
      target = resolve(cwd, expandHome(answer.trim() || defaultTarget));

      if (existsSync(target) && !statSync(target).isDirectory()) {
        say(`${target} is a file, not a folder. Pick another path.`);
        continue;
      }
      const code = existsSync(target) ? looksLikeCodeRepo(target) : { isCode: false };
      if (!code.isCode) break;

      say(`! ${target} looks like a code repository (${code.reason}).`);
      say('  The kit belongs in a separate SDLC repo, not inside your code.');
      let choice;
      for (;;) {
        const c = await ask('  [c]ontinue here anyway, pick [a]nother path, or [q]uit? ');
        if (c === null) return stop('Input closed.');
        choice = c.trim().toLowerCase()[0];
        if (choice && 'caq'.includes(choice)) break;
      }
      if (choice === 'q') return stop('Quit.');
      if (choice === 'c') break;
    }

    say('');
    say("Here's what will happen:");
    if (!existsSync(target)) say(`  - create the folder ${target}`);
    for (const a of preview(target)) say(`  - ${a}`);
    const go = await ask('Proceed? [Y/n] ');
    if (go === null) return stop('Input closed.');
    if (go.trim() && go.trim().toLowerCase()[0] !== 'y') return stop('Cancelled.');

    if (!dryRun && !existsSync(target)) mkdirSync(target, { recursive: true });
    return target;
  } finally {
    prompter.close();
  }
}
