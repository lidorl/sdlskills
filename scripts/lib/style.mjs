const CODES = { bold: [1, 22], dim: [2, 22], red: [31, 39], green: [32, 39], yellow: [33, 39], cyan: [36, 39] };

/** Colors on for a terminal; off for pipes, TERM=dumb and NO_COLOR; FORCE_COLOR overrides. */
export function colorEnabled(stream, env = process.env) {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0';
  return Boolean(stream?.isTTY) && env.TERM !== 'dumb';
}

/** Text styling functions; identity functions when colors are off. */
export function makeStyle(enabled) {
  return Object.fromEntries(
    Object.entries(CODES).map(([name, [open, close]]) => [
      name,
      enabled ? (text) => `\x1b[${open}m${text}\x1b[${close}m` : (text) => String(text),
    ]),
  );
}
