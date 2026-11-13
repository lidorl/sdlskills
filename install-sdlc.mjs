#!/usr/bin/env node
/**
 * install-sdlc.mjs — start here. Asks which tool you use (Claude Code or GitHub
 * Copilot), then runs the matching installer, which guides you through the rest.
 *
 * Usage:  node install-sdlc.mjs [<target-dir>] [--dry-run] [--skip-plugins] [--skip-npm]
 *
 * To skip the question (scripts, CI), run an installer directly:
 *   node scripts/install-sdlc.mjs <target-dir>          # Claude Code
 *   node scripts/install-sdlc-copilot.mjs <target-dir>  # GitHub Copilot
 */
import { main, CLAUDE_LAYOUT } from './scripts/install-sdlc.mjs';
import { COPILOT_LAYOUT } from './scripts/install-sdlc-copilot.mjs';
import { chooseTool } from './scripts/lib/choose-tool.mjs';
import { isEntryPoint } from './scripts/lib/is-entry-point.mjs';

if (isEntryPoint(import.meta.url)) {
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    console.error(
      'usage: node install-sdlc.mjs   (run in a terminal; it asks which tool you use)\n' +
        'To skip the question, run an installer directly:\n' +
        '  node scripts/install-sdlc.mjs <target-dir>          # Claude Code\n' +
        '  node scripts/install-sdlc-copilot.mjs <target-dir>  # GitHub Copilot',
    );
    process.exit(1);
  }
  const tool = await chooseTool({ input: process.stdin, output: process.stdout });
  if (!tool) {
    console.log('\nNo tool chosen. Nothing was changed.');
    process.exitCode = 1;
  } else {
    console.log('');
    await main(tool === 'copilot' ? COPILOT_LAYOUT : CLAUDE_LAYOUT);
  }
}
