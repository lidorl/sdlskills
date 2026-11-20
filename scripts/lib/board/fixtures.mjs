// Test helper: a bare "remote" seeded like a board-enabled repo, plus clone factory.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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

export function makeBoard({ featReqs = {}, board = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'board-fx-'));
  const remote = join(dir, 'remote.git');
  git(dir, ['init', '--bare', '-b', 'main', remote]);

  const seeder = join(dir, 'seeder');
  git(dir, ['clone', remote, seeder]);
  git(seeder, ['checkout', '-B', 'main']);
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
  git(seeder, ['add', '-A']);
  git(seeder, ['commit', '-m', 'seed']);
  git(seeder, ['push', 'origin', 'main']);

  return {
    dir,
    remote,
    clone(name, ident = IDENT) {
      const path = join(dir, name);
      git(dir, ['clone', remote, path]);
      setIdent(path, ident);
      return path;
    },
    // Commit a file straight onto the remote's main (repo-relative `file`), via the seeder clone.
    seed(file, content, msg = `seed ${file}`) {
      git(seeder, ['pull', '--ff-only', 'origin', 'main']);
      writeIn(seeder, file, content);
      git(seeder, ['add', '-A']);
      git(seeder, ['commit', '-m', msg]);
      git(seeder, ['push', 'origin', 'main']);
    },
  };
}
