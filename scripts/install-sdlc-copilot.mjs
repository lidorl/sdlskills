#!/usr/bin/env node
/**
 * install-sdlc-copilot.mjs — scaffold the SDLC kit for GitHub Copilot (VS Code
 * agent mode and Copilot CLI; the non-interactive cloud agent is out of scope).
 *
 * Same flow, flags, and re-run behavior as install-sdlc.mjs. The kit stays
 * authored for Claude Code; this layout renames paths and rewrites references
 * as files land in the target:
 *
 *   .claude/skills/         -> .github/skills/
 *   CLAUDE.process.md       -> .github/instructions/sdlc-process.instructions.md
 *   CLAUDE.stack.md         -> .github/instructions/sdlc-stack.instructions.md
 *   CLAUDE.md               -> .github/copilot-instructions.md
 *   Stop hook               -> agentStop hook in .github/hooks/sdlc-status.json
 *   superpowers:<skill>     -> <skill>
 *
 * The contract ships as instruction files because Copilot does not reliably
 * follow links between instruction files. `/code-review` and `/security-review`
 * ship as skills (copilot/skills/) because VS Code has no such commands.
 *
 * Usage:  node /path/to/sdlskills/scripts/install-sdlc-copilot.mjs <target-dir> [flags]
 * Flags:  --skip-plugins  --skip-npm  --dry-run
 */
import { CLAUDE_LAYOUT, main } from './install-sdlc.mjs';
import { isEntryPoint } from './lib/is-entry-point.mjs';

const PROCESS_FILE = '.github/instructions/sdlc-process.instructions.md';
const STACK_FILE = '.github/instructions/sdlc-stack.instructions.md';
const INSTRUCTIONS_FILE = '.github/copilot-instructions.md';
const HOOK_FILE = '.github/hooks/sdlc-status.json';

/**
 * Applied in order. The sentence-level rules come first because the path rules
 * would otherwise consume their anchors. install-sdlc-copilot.test.mjs fails if
 * a kit edit introduces wording these rules miss.
 */
const REWRITES = [
  [
    /Drop this file into a project \(as `CLAUDE\.md`, or referenced from it\) to make Claude Code work/g,
    'This file is always loaded as a Copilot instruction file, so GitHub Copilot works',
  ],
  [/ and referenced from `CLAUDE\.md`/g, ''],
  [/ Reference it from `CLAUDE\.md`\./g, ''],
  [/CLAUDE\.process\.md/g, PROCESS_FILE],
  [/CLAUDE\.stack\.md/g, STACK_FILE],
  [/CLAUDE\.md/g, INSTRUCTIONS_FILE],
  [/\.claude\/settings\.json/g, HOOK_FILE],
  [/\.claude\/skills/g, '.github/skills'],
  [/`Stop` hook/g, '`agentStop` hook'],
  [/install-sdlc\.mjs/g, 'install-sdlc-copilot.mjs'],
  [/superpowers:([a-z-]+)/g, '$1'],
  [/Claude Code/g, 'GitHub Copilot'],
];

const adapt = (text) => REWRITES.reduce((t, [from, to]) => t.replace(from, to), text);

/** Output is silenced: hook stdout is parsed as a control response. */
const STATUS_HOOK = {
  version: 1,
  hooks: {
    agentStop: [
      {
        type: 'command',
        bash: 'node scripts/render-status.mjs >/dev/null 2>&1 || true',
        powershell: 'node scripts/render-status.mjs *> $null',
      },
    ],
  },
};

export const COPILOT_LAYOUT = {
  ...CLAUDE_LAYOUT,
  installer: 'install-sdlc-copilot.mjs',
  toolName: 'GitHub Copilot',
  otherInstaller: 'install-sdlc.mjs',
  // VS Code agent mode works without the CLI; the CLI is only needed to install the plugin.
  cliRequired: false,
  cliInstallHint:
    'Optional for VS Code. To install the superpowers plugin from here, install the Copilot CLI: npm install -g @github/copilot',
  skillsDir: '.github/skills',
  extraSkills: ['copilot/skills/code-review', 'copilot/skills/security-review'],
  processFile: PROCESS_FILE,
  stackFile: STACK_FILE,
  docHeader: "---\napplyTo: '**'\n---\n\n",
  adapt,
  extraFiles: { [HOOK_FILE]: JSON.stringify(STATUS_HOOK, null, 2) + '\n' },
  plugin: {
    cli: 'copilot',
    commands: [
      ['plugin', 'marketplace', 'add', 'obra/superpowers-marketplace'],
      ['plugin', 'install', 'superpowers@superpowers-marketplace'],
    ],
    notes: [
      'VS Code: set `chat.plugins.enabled` so it discovers the plugin installed by the Copilot CLI. Without the CLI, run "Chat: Install Plugin from Source" with https://github.com/obra/superpowers.',
    ],
  },
  nextSteps: [`Adapt \`${STACK_FILE}\` to the real stack (or let \`/setup-sdlc\` do it).`],
};

if (isEntryPoint(import.meta.url)) main(COPILOT_LAYOUT);
