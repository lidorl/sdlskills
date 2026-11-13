/** The end-of-run summary: what was done, what needs attention, what to do next. */
export function formatReport({ title, actions, warnings, nextSteps }) {
  const lines = ['', `${title}:`, '', 'Done'];
  for (const a of actions) lines.push(`  ✓ ${a}`);
  if (warnings.length) {
    lines.push('', 'Needs attention');
    for (const w of warnings) lines.push(`  ! ${w}`);
  }
  lines.push('', 'Next steps');
  nextSteps.forEach((n, i) => lines.push(`  ${i + 1}. ${n}`));
  return lines.join('\n');
}
