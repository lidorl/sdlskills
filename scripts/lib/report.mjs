import { makeStyle } from './style.mjs';

/** The end-of-run summary: what was done, what needs attention, what to do next. */
export function formatReport({ title, actions, warnings, nextSteps, style = makeStyle(false) }) {
  const lines = ['', style.bold(`${title}:`), '', style.bold('Done')];
  for (const a of actions) lines.push(`  ${style.green('✓')} ${a}`);
  if (warnings.length) {
    lines.push('', style.bold('Needs attention'));
    for (const w of warnings) lines.push(`  ${style.yellow('!')} ${w}`);
  }
  lines.push('', style.bold('Next steps'));
  nextSteps.forEach((n, i) => lines.push(`  ${style.dim(`${i + 1}.`)} ${n}`));
  return lines.join('\n');
}
