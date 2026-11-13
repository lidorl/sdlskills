import { makePrompter } from './prompter.mjs';

const CHOICES = {
  1: 'claude',
  claude: 'claude',
  'claude code': 'claude',
  2: 'copilot',
  copilot: 'copilot',
  'github copilot': 'copilot',
};

/**
 * Asks which tool the kit is for.
 * @returns {Promise<'claude'|'copilot'|null>} null when input closes.
 */
export async function chooseTool({ input, output }) {
  const prompter = makePrompter(input, output);
  try {
    output.write('Which tool will you use the kit with?\n  1) Claude Code\n  2) GitHub Copilot (VS Code or CLI)\n');
    for (;;) {
      const answer = await prompter.ask('Choose 1 or 2: ');
      if (answer === null) return null;
      const tool = CHOICES[answer.trim().toLowerCase()];
      if (tool) return tool;
      output.write('Please type 1 or 2.\n');
    }
  } finally {
    prompter.close();
  }
}
