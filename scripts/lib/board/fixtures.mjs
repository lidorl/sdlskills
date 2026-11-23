// Test helper: a bare "remote" seeded like a board-enabled repo, plus clone factory.
// Each distinct board shape is built once per process (a template) and copied per test, so a test pays
// for a directory copy instead of a dozen git processes.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';

export const IDENT = { name: 'Test Owner', email: 'owner@example.com' };

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function setIdent(path, ident = IDENT) {
  git(path, ['config', 'user.name', ident.name]);
  git(path, ['config', 'user.email', ident.email]);
}

function writeIn(root, file, content) {
  const abs = join(root, file);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

const templates = new Map();

// The template: remote.git, a seeder clone, and a pristine clone (`_clone`) of the seeded main.
function buildTemplate({ featReqs, board, files }) {
  const dir = mkdtempSync(join(tmpdir(), 'board-tpl-'));
  const remote = join(dir, 'remote.git');
  git(dir, ['init', '--bare', '-q', '-b', 'main', remote]);

  const seeder = join(dir, 'seeder');
  git(dir, ['clone', '-q', remote, seeder]);
  git(seeder, ['checkout', '-q', '-B', 'main']);
  setIdent(seeder);
  writeIn(seeder, 'README.md', '# fixture\n');
  for (const [slug, fm] of Object.entries(featReqs)) {
    const yaml = Object.keys(fm).length ? stringify(fm) : '';
    writeIn(seeder, `docs/feat-req/${slug}.md`, `---\n${yaml}---\n\n# ${slug}\n`);
  }
  if (board) {
    writeIn(seeder, 'board/workers/.gitkeep', '');
    writeIn(seeder, 'board/requests/.gitkeep', '');
  }
  for (const [file, content] of Object.entries(files)) writeIn(seeder, file, content);
  git(seeder, ['add', '-A']);
  git(seeder, ['commit', '-q', '-m', 'seed']);
  git(seeder, ['push', '-q', 'origin', 'main']);
  git(dir, ['clone', '-q', remote, join(dir, '_clone')]);
  setIdent(join(dir, '_clone'));
  return { dir, head: git(seeder, ['rev-parse', 'HEAD']).trim() };
}

// Point a copied clone's origin at this fixture's remote (plain text edit, no git process).
function repoint(clone, from, to) {
  const cfg = join(clone, '.git', 'config');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replaceAll(from, to));
}

function remoteHead(remote) {
  const loose = join(remote, 'refs', 'heads', 'main');
  if (existsSync(loose)) return readFileSync(loose, 'utf8').trim();
  return git(remote, ['rev-parse', 'main']).trim();
}

// featReqs: { slug: frontmatter }; files: { path: content } committed in the same seed commit.
export function makeBoard({ featReqs = {}, board = true, files = {} } = {}) {
  const key = JSON.stringify({ featReqs, board, files });
  if (!templates.has(key)) templates.set(key, buildTemplate({ featReqs, board, files }));
  const tpl = templates.get(key);

  const dir = mkdtempSync(join(tmpdir(), 'board-fx-'));
  cpSync(tpl.dir, dir, { recursive: true });
  const remote = join(dir, 'remote.git');
  const seeder = join(dir, 'seeder');
  repoint(seeder, tpl.dir, dir);

  return {
    dir,
    remote,
    clone(name, ident = IDENT) {
      const path = join(dir, name);
      if (remoteHead(remote) === tpl.head) {
        cpSync(join(dir, '_clone'), path, { recursive: true });
        repoint(path, join(tpl.dir, 'remote.git'), remote);
        if (ident !== IDENT) setIdent(path, ident);
      } else {
        git(dir, ['clone', '-q', remote, path]);
        setIdent(path, ident);
      }
      return path;
    },
    // Commit a file straight onto the remote's main (repo-relative `file`), via the seeder clone.
    seed(file, content, msg = `seed ${file}`) {
      git(seeder, ['pull', '-q', '--ff-only', 'origin', 'main']);
      writeIn(seeder, file, content);
      git(seeder, ['add', '-A']);
      git(seeder, ['commit', '-q', '-m', msg]);
      git(seeder, ['push', '-q', 'origin', 'main']);
    },
  };
}
