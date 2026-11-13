#!/usr/bin/env node
/**
 * install-sdlc.mjs — scaffold the SDLC kit into a target project.
 *
 * Automates the mechanical half of "Adopting the kit in a project" (see the
 * kit's CLAUDE.md): vendors the phase skills, copies the scripts, drops in
 * CLAUDE.process.md, wires package.json / .gitignore, builds the docs skeleton,
 * and installs the superpowers plugin. The interactive part — repo mapping,
 * the autonomy interview — is still `/setup-sdlc`, run afterward.
 *
 * Usage:  node /path/to/sdlskills/scripts/install-sdlc.mjs <target-dir> [flags]
 * Flags:  --skip-plugins  --skip-npm  --dry-run
 *
 * Re-running is the update path: kit-owned files (skills, scripts) are
 * overwritten; user files (CLAUDE.stack.md, package.json, .gitignore) are
 * preserved and merged.
 *
 * The kit is authored for Claude Code. A layout maps it onto another harness at
 * install time; see install-sdlc-copilot.mjs.
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  cpSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { isEntryPoint } from './lib/is-entry-point.mjs';
import { commandAvailable, runCli } from './lib/prereqs.mjs';

/** The phase skills, vendored into <target>/.claude/skills/. */
export const SKILLS = [
  'setup-sdlc',
  'write-feature-request',
  'classify-change',
  'write-design-doc',
  'write-execution-plan',
  'write-history-entry',
  'select-next-task',
  'gather-open-items',
  'close-out',
];

/** docs/ subdirectories the process expects to exist. */
export const DOCS_DIRS = ['feat-req', 'design', 'plans', 'history', 'decisions'];

/** Lines the kit needs ignored. Appended to an existing .gitignore if absent. */
export const GITIGNORE_LINES = [
  'docs/STATUS.md',
  'docs/.status.json',
  'node_modules/',
  'workspace/',
];

/** package.json fields the kit relies on. Filled in only where missing. */
const PKG_DEFAULTS = {
  type: 'module',
  private: true,
  scripts: {
    test: 'node --test "scripts/**/*.test.mjs"',
    status: 'node scripts/render-status.mjs',
  },
  dependencies: { yaml: '^2.5.0' },
};

/**
 * Where the kit lands in a target and how its text is adapted for the harness.
 * This default is the kit as authored; other harnesses supply their own.
 */
export const CLAUDE_LAYOUT = {
  installer: 'install-sdlc.mjs',
  toolName: 'Claude Code',
  /** The other harness's installer, named in the guided flow. */
  otherInstaller: 'install-sdlc-copilot.mjs',
  /** Whether a missing CLI blocks the guided install. */
  cliRequired: true,
  cliInstallHint: 'Install Claude Code from https://docs.claude.com/en/docs/claude-code/overview',
  skillsDir: '.claude/skills',
  /** Kit-relative skill directories vendored in addition to SKILLS. */
  extraSkills: [],
  processFile: 'CLAUDE.process.md',
  stackFile: 'CLAUDE.stack.md',
  /** Prepended to the process and stack docs. */
  docHeader: '',
  /** Rewrites the text of vendored skills and docs. */
  adapt: (text) => text,
  /** Target-relative path -> content. Kit-owned, rewritten every run. */
  extraFiles: {},
  plugin: {
    cli: 'claude',
    commands: [
      ['plugin', 'marketplace', 'add', 'claude-plugins-official'],
      ['plugin', 'install', 'superpowers@claude-plugins-official'],
    ],
    /** Extra manual guidance shown whether or not the plugin installed. */
    notes: [],
  },
  nextSteps: ["Reference `CLAUDE.process.md` and `CLAUDE.stack.md` from the target's `CLAUDE.md`."],
};

/**
 * @param {object} opts
 * @param {string} opts.kitRoot     - this repo's root (where skills/, scripts/ live)
 * @param {string} opts.targetDir   - project to scaffold into (must exist)
 * @param {boolean} [opts.skipPlugins]
 * @param {boolean} [opts.skipNpm]
 * @param {boolean} [opts.dryRun]
 * @param {typeof CLAUDE_LAYOUT} [opts.layout]
 * @returns {{ actions: string[], warnings: string[], nextSteps: string[] }}
 */
export function install({
  kitRoot,
  targetDir,
  skipPlugins = false,
  skipNpm = false,
  dryRun = false,
  layout = CLAUDE_LAYOUT,
}) {
  if (!existsSync(targetDir)) throw new Error(`target directory does not exist: ${targetDir}`);
  if (!existsSync(join(kitRoot, 'skills'))) throw new Error(`not a kit root (no skills/): ${kitRoot}`);

  const actions = [];
  const warnings = [];
  const nextSteps = [];
  const did = (msg) => actions.push(dryRun ? `[dry-run] ${msg}` : msg);
  const mkdir = (d) => {
    if (!dryRun) mkdirSync(d, { recursive: true });
  };
  const copy = (src, dst) => {
    if (!dryRun) {
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(src, dst, { recursive: true });
    }
  };
  const writeDoc = (src, dst) => {
    if (!dryRun) {
      mkdirSync(dirname(dst), { recursive: true });
      writeFileSync(dst, layout.docHeader + layout.adapt(readFileSync(src, 'utf8')));
    }
  };
  const adaptTree = (dir) => {
    if (dryRun) return;
    for (const f of readdirSync(dir, { recursive: true })) {
      if (!f.endsWith('.md')) continue;
      const p = join(dir, f);
      const text = readFileSync(p, 'utf8');
      const adapted = layout.adapt(text);
      if (adapted !== text) writeFileSync(p, adapted);
    }
  };

  if (!existsSync(join(targetDir, '.git'))) {
    warnings.push(
      'meta-root is not a git repository — recommended: `git init` so the docs trail (feature requests, designs, plans, history) is versioned.',
    );
  }

  // 1. Vendor the phase skills (kit-owned — overwrite on re-run).
  const skillsDst = join(targetDir, layout.skillsDir);
  const skillSources = [...SKILLS.map((s) => join('skills', s)), ...layout.extraSkills];
  for (const rel of skillSources) {
    const src = join(kitRoot, rel);
    const name = basename(rel);
    if (!existsSync(src)) {
      warnings.push(`skill missing from kit, skipped: ${name}`);
      continue;
    }
    copy(src, join(skillsDst, name));
    adaptTree(join(skillsDst, name));
  }
  did(`vendored ${skillSources.length} skills into ${layout.skillsDir}/`);

  // 2. Copy the scripts (kit-owned — overwrite on re-run). Skip the installers.
  const scriptsDst = join(targetDir, 'scripts');
  const scriptEntries = readdirSync(join(kitRoot, 'scripts')).filter(
    (e) => !e.startsWith('install-sdlc'),
  );
  for (const e of scriptEntries) copy(join(kitRoot, 'scripts', e), join(scriptsDst, e));
  did(`copied ${scriptEntries.length} script entries into scripts/`);

  // 3. Process docs. The process doc is kit-owned; the rest are seeds (keep if present).
  writeDoc(join(kitRoot, 'CLAUDE.process.md'), join(targetDir, layout.processFile));
  did(`copied ${layout.processFile}`);
  for (const [src, dst, place] of [
    ['CLAUDE.stack.example.md', layout.stackFile, writeDoc],
    ['repos.example.yml', 'repos.example.yml', copy],
  ]) {
    if (existsSync(join(targetDir, dst))) {
      did(`kept existing ${dst}`);
    } else {
      place(join(kitRoot, src), join(targetDir, dst));
      did(`seeded ${dst} from ${src}`);
    }
  }
  for (const [path, content] of Object.entries(layout.extraFiles)) {
    if (!dryRun) {
      mkdirSync(dirname(join(targetDir, path)), { recursive: true });
      writeFileSync(join(targetDir, path), content);
    }
    did(`wrote ${path}`);
  }

  // 4. package.json — create or merge in the fields the kit needs.
  const pkgPath = join(targetDir, 'package.json');
  const pkgExisted = existsSync(pkgPath);
  const pkg = pkgExisted ? JSON.parse(readFileSync(pkgPath, 'utf8')) : {};
  const before = JSON.stringify(pkg);
  pkg.name ??= basename(targetDir);
  pkg.type ??= PKG_DEFAULTS.type;
  pkg.private ??= PKG_DEFAULTS.private;
  pkg.scripts = { ...PKG_DEFAULTS.scripts, ...pkg.scripts };
  pkg.dependencies = { ...pkg.dependencies };
  pkg.dependencies.yaml ??= PKG_DEFAULTS.dependencies.yaml;
  if (JSON.stringify(pkg) !== before) {
    if (!dryRun) writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    did(pkgExisted ? 'merged package.json' : 'created package.json');
  } else {
    did('package.json already satisfied');
  }

  // 5. .gitignore — append missing lines.
  const giPath = join(targetDir, '.gitignore');
  const current = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
  const have = new Set(current.split('\n').map((l) => l.trim()));
  const missing = GITIGNORE_LINES.filter((l) => !have.has(l));
  if (missing.length) {
    const block =
      (current && !current.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n';
    if (!dryRun) writeFileSync(giPath, current + block);
    did(`appended ${missing.length} line(s) to .gitignore`);
  } else {
    did('.gitignore already covers the kit');
  }

  // 6. docs skeleton.
  for (const d of DOCS_DIRS) {
    const dir = join(targetDir, 'docs', d);
    mkdir(dir);
    if (!dryRun && !existsSync(join(dir, '.gitkeep'))) writeFileSync(join(dir, '.gitkeep'), '');
  }
  did(`created docs/{${DOCS_DIRS.join(',')}}/`);

  // 7. superpowers plugin.
  const { cli, commands, notes } = layout.plugin;
  const manualInstall = commands.map((c) => `\`${cli} ${c.join(' ')}\``).join(' then ');
  if (skipPlugins) {
    nextSteps.push(`Install the superpowers plugin: ${manualInstall}`);
  } else if (dryRun) {
    did('[dry-run] would install superpowers plugin');
  } else if (commandAvailable(cli)) {
    try {
      for (const c of commands) runCli(cli, c, { stdio: 'inherit' });
      did('installed superpowers plugin');
    } catch {
      warnings.push('superpowers plugin install failed — install it manually.');
    }
  } else {
    warnings.push(`\`${cli}\` not on PATH — skipped plugin install.`);
    nextSteps.push(`Install the superpowers plugin once \`${cli}\` is available: ${manualInstall}`);
  }
  nextSteps.push(...notes);

  // 8. npm install.
  if (skipNpm) {
    nextSteps.push('Run `npm install` in the target to pull in `yaml`.');
  } else if (dryRun) {
    did('[dry-run] would run npm install');
  } else {
    try {
      execFileSync('npm', ['install'], { cwd: targetDir, stdio: 'inherit' });
      did('ran npm install');
    } catch {
      warnings.push('`npm install` failed — run it manually in the target.');
    }
  }

  nextSteps.push(
    ...layout.nextSteps,
    'Run `/setup-sdlc` in the target to map the repo and run the autonomy interview.',
  );

  return { actions, warnings, nextSteps };
}

export function main(layout = CLAUDE_LAYOUT) {
  const args = process.argv.slice(2);
  const targetDir = args.find((a) => !a.startsWith('--'));
  if (!targetDir) {
    console.error(`usage: node ${layout.installer} <target-dir> [--skip-plugins] [--skip-npm] [--dry-run]`);
    process.exit(1);
  }
  const kitRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const r = install({
    kitRoot,
    targetDir,
    skipPlugins: args.includes('--skip-plugins'),
    skipNpm: args.includes('--skip-npm'),
    dryRun: args.includes('--dry-run'),
    layout,
  });

  console.log(`\n${layout.installer.replace(/\.mjs$/, '')}:`);
  for (const a of r.actions) console.log(`  ✓ ${a}`);
  if (r.warnings.length) {
    console.log('\nwarnings:');
    for (const w of r.warnings) console.log(`  ! ${w}`);
  }
  console.log('\nnext steps:');
  for (const n of r.nextSteps) console.log(`  → ${n}`);
}

if (isEntryPoint(import.meta.url)) main();
