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

function claudeAvailable() {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.kitRoot     - this repo's root (where skills/, scripts/ live)
 * @param {string} opts.targetDir   - project to scaffold into (must exist)
 * @param {boolean} [opts.skipPlugins]
 * @param {boolean} [opts.skipNpm]
 * @param {boolean} [opts.dryRun]
 * @returns {{ actions: string[], warnings: string[], nextSteps: string[] }}
 */
export function install({ kitRoot, targetDir, skipPlugins = false, skipNpm = false, dryRun = false }) {
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

  if (!existsSync(join(targetDir, '.git'))) {
    warnings.push('target is not a git repository — run `git init` there before committing.');
  }

  // 1. Vendor the phase skills (kit-owned — overwrite on re-run).
  const skillsDst = join(targetDir, '.claude', 'skills');
  for (const s of SKILLS) {
    const src = join(kitRoot, 'skills', s);
    if (!existsSync(src)) {
      warnings.push(`skill missing from kit, skipped: ${s}`);
      continue;
    }
    copy(src, join(skillsDst, s));
  }
  did(`vendored ${SKILLS.length} skills into .claude/skills/`);

  // 2. Copy the scripts (kit-owned — overwrite on re-run). Skip this installer.
  const self = basename(fileURLToPath(import.meta.url));
  const selfTest = self.replace(/\.mjs$/, '.test.mjs');
  const scriptsDst = join(targetDir, 'scripts');
  const scriptEntries = readdirSync(join(kitRoot, 'scripts')).filter(
    (e) => e !== self && e !== selfTest,
  );
  for (const e of scriptEntries) copy(join(kitRoot, 'scripts', e), join(scriptsDst, e));
  did(`copied ${scriptEntries.length} script entries into scripts/`);

  // 3. Process docs. CLAUDE.process.md is kit-owned; the rest are seeds (keep if present).
  copy(join(kitRoot, 'CLAUDE.process.md'), join(targetDir, 'CLAUDE.process.md'));
  did('copied CLAUDE.process.md');
  for (const [src, dst] of [
    ['CLAUDE.stack.example.md', 'CLAUDE.stack.md'],
    ['repos.example.yml', 'repos.example.yml'],
  ]) {
    if (existsSync(join(targetDir, dst))) {
      did(`kept existing ${dst}`);
    } else {
      copy(join(kitRoot, src), join(targetDir, dst));
      did(`seeded ${dst} from ${src}`);
    }
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
  if (skipPlugins) {
    nextSteps.push(
      'Install the superpowers plugin: `claude plugin marketplace add claude-plugins-official` then `claude plugin install superpowers@claude-plugins-official`',
    );
  } else if (dryRun) {
    did('[dry-run] would install superpowers plugin');
  } else if (claudeAvailable()) {
    try {
      execFileSync('claude', ['plugin', 'marketplace', 'add', 'claude-plugins-official'], {
        stdio: 'inherit',
      });
      execFileSync('claude', ['plugin', 'install', 'superpowers@claude-plugins-official'], {
        stdio: 'inherit',
      });
      did('installed superpowers plugin');
    } catch {
      warnings.push('superpowers plugin install failed — install it manually.');
    }
  } else {
    warnings.push('`claude` not on PATH — skipped plugin install.');
    nextSteps.push(
      'Install the superpowers plugin once `claude` is available: `claude plugin marketplace add claude-plugins-official` then `claude plugin install superpowers@claude-plugins-official`',
    );
  }

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
    'Reference `CLAUDE.process.md` and `CLAUDE.stack.md` from the target\'s `CLAUDE.md`.',
    'Run `/setup-sdlc` in the target to map the repo and run the autonomy interview.',
  );

  return { actions, warnings, nextSteps };
}

function main() {
  const args = process.argv.slice(2);
  const targetDir = args.find((a) => !a.startsWith('--'));
  if (!targetDir) {
    console.error('usage: node install-sdlc.mjs <target-dir> [--skip-plugins] [--skip-npm] [--dry-run]');
    process.exit(1);
  }
  const kitRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const r = install({
    kitRoot,
    targetDir,
    skipPlugins: args.includes('--skip-plugins'),
    skipNpm: args.includes('--skip-npm'),
    dryRun: args.includes('--dry-run'),
  });

  console.log('\ninstall-sdlc:');
  for (const a of r.actions) console.log(`  ✓ ${a}`);
  if (r.warnings.length) {
    console.log('\nwarnings:');
    for (const w of r.warnings) console.log(`  ! ${w}`);
  }
  console.log('\nnext steps:');
  for (const n of r.nextSteps) console.log(`  → ${n}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
