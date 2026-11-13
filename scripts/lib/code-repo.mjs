import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE_DIRS = ['src', 'app', 'lib'];
const MANIFESTS = ['pyproject.toml', 'go.mod', 'pom.xml', 'Cargo.toml'];
/** Dependencies the kit itself adds to a meta-root's package.json. */
const KIT_DEPENDENCIES = new Set(['yaml']);
const KIT_SKILL_MARKERS = ['.claude/skills/write-design-doc', '.github/skills/write-design-doc'];

/**
 * Does `dir` look like an application's code repository rather than a place to
 * install the kit? Only ever a warning for the caller to show.
 * @returns {{ isCode: boolean, reason: string }}
 */
export function looksLikeCodeRepo(dir) {
  const no = { isCode: false, reason: '' };
  if (KIT_SKILL_MARKERS.some((m) => existsSync(join(dir, m)))) return no;
  if (!existsSync(join(dir, '.git'))) return no;

  for (const d of SOURCE_DIRS) {
    if (existsSync(join(dir, d))) return { isCode: true, reason: `has a ${d}/ folder` };
  }
  for (const f of MANIFESTS) {
    if (existsSync(join(dir, f))) return { isCode: true, reason: `has ${f}` };
  }
  const csproj = readdirSync(dir).find((f) => f.endsWith('.csproj'));
  if (csproj) return { isCode: true, reason: `has ${csproj}` };

  const pkgPath = join(dir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const deps = Object.keys(JSON.parse(readFileSync(pkgPath, 'utf8')).dependencies ?? {});
      if (deps.some((d) => !KIT_DEPENDENCIES.has(d))) {
        return { isCode: true, reason: 'has a package.json with application dependencies' };
      }
    } catch {
      // An unreadable package.json is not evidence of anything.
    }
  }
  return no;
}
