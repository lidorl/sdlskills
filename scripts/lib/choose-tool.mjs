import { createUi } from './ui.mjs';

const TOOLS = [
  { label: 'Claude Code', value: 'claude', key: 'c', aliases: ['claude code'] },
  { label: 'GitHub Copilot (VS Code or CLI)', value: 'copilot', key: 'g', aliases: ['github copilot'] },
];

/**
 * Asks which tool the kit is for: an arrow-key menu in a terminal, numbered
 * choices elsewhere.
 * @returns {Promise<'claude'|'copilot'|null>} null when cancelled or input closes.
 */
export async function chooseTool({ input, output, env = process.env }) {
  const ui = createUi({ input, output, env });
  try {
    return await ui.select({ message: 'Which tool will you use the kit with?', choices: TOOLS });
  } finally {
    ui.close();
  }
}
