import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { checkPrereqs } from './prereqs.mjs';
import { looksLikeCodeRepo } from './code-repo.mjs';
import { completePath } from './complete-path.mjs';
import { createUi } from './ui.mjs';

const expandHome = (p) => (p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? join(homedir(), p.slice(1)) : p);

const CODE_REPO_CHOICES = [
  { label: 'Continue here anyway', value: 'c', key: 'c', aliases: ['continue'] },
  { label: 'Pick another path', value: 'a', key: 'a', aliases: ['another'] },
  { label: 'Quit', value: 'q', key: 'q', aliases: ['quit'] },
];
const PROCEED_CHOICES = [
  { label: 'Yes, install', value: 'y', key: 'y', aliases: ['yes'] },
  { label: 'No, cancel', value: 'n', key: 'n', aliases: ['no'] },
];

/**
 * Walks a first-time user through the install: explains the meta-root, checks
 * prerequisites, picks and sanity-checks the location, shows the plan.
 *
 * @returns the absolute target directory to install into, or null if the user
 *          quit, a required prerequisite is missing, or input closed.
 */
export async function runGuide({
  layout,
  cwd,
  kitRoot,
  input,
  output,
  env = process.env,
  available,
  nodeVersion,
  dryRun = false,
  preview,
}) {
  const ui = createUi({ input, output, env });
  const { say, style } = ui;
  const stop = (why) => {
    say(`\n${why} Nothing was changed.`);
    return null;
  };

  try {
    // Started from the kit repo itself: there is no "your project" to name a default after.
    const inKit = Boolean(kitRoot) && resolve(kitRoot) === resolve(cwd);
    const name = inKit ? 'your-code-repo' : basename(cwd);
    const sdlcName = inKit ? 'your-sdlc-repo' : `${name}-workspace`;
    const defaultTarget = inKit ? null : join(dirname(cwd), sdlcName);

    say(style.bold(`This installs the SDLC kit for ${layout.toolName} into your SDLC repo (the *meta-root*).`));
    say('');
    say("The meta-root is a separate folder, and git repo, that holds the process, the kit's skills");
    say('and the docs/ trail. It is not your code: your code repositories stay untouched and are');
    say('checked out under workspace/ when you start work.');
    say('');
    const tree = [
      [`${sdlcName}/`, '<- install here (your SDLC repo)'],
      ['├── docs/', 'feature requests, designs, plans, history'],
      [`├── ${layout.skillsDir}/`, "the kit's skills"],
      [`└── workspace/${name}/`, 'checkouts of your code repos, created later'],
    ];
    const width = Math.max(...tree.map(([left]) => left.length)) + 3;
    for (const [left, note] of tree) say(`  ${style.cyan(left.padEnd(width))}${style.dim(note)}`);
    say('');
    say(`This installer is for ${layout.toolName}. Using a different tool? Run scripts/${layout.otherInstaller} instead.`);
    say('');

    say(style.bold('Prerequisites:'));
    const prereqs = checkPrereqs({ layout, nodeVersion, available });
    for (const p of prereqs) {
      if (p.ok) say(`  ${style.green('✓')} ${p.label}`);
      else if (p.required) say(`  ${style.red('✗')} ${p.label}: ${p.fix}`);
      else say(`  ${style.yellow('-')} ${p.label} ${style.dim('(optional)')}: ${p.fix}`);
    }
    if (prereqs.some((p) => p.required && !p.ok)) {
      return stop('Fix the items marked ✗ above, then run this again.');
    }
    say('');

    /** Asks for a location until it is usable. Returns the path, or null after stop(). */
    const choosePath = async () => {
      const question = defaultTarget
        ? `${style.cyan('?')} ${style.bold('Where should the SDLC repo go?')} ${style.dim(`(${defaultTarget})`)} `
        : `${style.cyan('?')} ${style.bold('Where should the SDLC repo go?')} ${style.dim('Type a folder path (created if needed; Tab completes; not your code repo)')}\n> `;
      for (;;) {
        const answer = await ui.ask(question, { completer: (line) => completePath(line, { cwd }) });
        if (answer === null) return stop('Cancelled.');
        const chosen = answer.trim() || defaultTarget;
        if (!chosen) {
          say('Please enter a folder path.');
          continue;
        }
        const target = resolve(cwd, expandHome(chosen));

        if (existsSync(target) && !statSync(target).isDirectory()) {
          say(`${target} is a file, not a folder. Pick another path.`);
          continue;
        }
        const code = existsSync(target) ? looksLikeCodeRepo(target) : { isCode: false };
        if (!code.isCode) return target;

        say(`${style.yellow('!')} ${target} looks like a code repository (${code.reason}).`);
        say('  The kit belongs in a separate SDLC repo, not inside your code.');
        const choice = await ui.select({ message: 'What now?', choices: CODE_REPO_CHOICES });
        if (choice === null || choice === 'q') return stop(choice === null ? 'Cancelled.' : 'Quit.');
        if (choice === 'c') return target;
      }
    };

    for (;;) {
      const target = await choosePath();
      if (target === null) return null;

      say('');
      say(style.bold("Here's what will happen:"));
      if (!existsSync(target)) say(`  ${style.dim('-')} create the folder ${target}`);
      for (const a of preview(target)) say(`  ${style.dim('-')} ${a}`);
      const go = await ui.select({ message: 'Proceed?', choices: PROCEED_CHOICES, initial: 0 });
      if (go === null) return stop('Cancelled.');
      if (go === 'n') return stop('Cancelled.');

      if (!dryRun && !existsSync(target)) {
        try {
          mkdirSync(target, { recursive: true });
        } catch (err) {
          say(`Can't create ${target}: ${err.message}. Pick another path.`);
          say('');
          continue;
        }
      }
      return target;
    }
  } finally {
    ui.close();
  }
}
