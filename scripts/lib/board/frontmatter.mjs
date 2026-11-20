// Read and edit YAML frontmatter on Markdown docs without disturbing the body.
import { parseDocument } from 'yaml';

export class FrontmatterError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FrontmatterError';
  }
}

const FM = /^---\r?\n(?:---|([\s\S]*?)\r?\n---)(?=\r?\n|$)/;

function split(text) {
  const m = FM.exec(text);
  if (!m) return { yaml: null, rest: text };
  return { yaml: m[1] ?? '', rest: text.slice(m[0].length) };
}

function parseYaml(src) {
  const doc = parseDocument(src);
  if (doc.errors.length) throw new FrontmatterError(doc.errors[0].message);
  return doc;
}

export function parseDoc(text) {
  const { yaml, rest } = split(text);
  if (yaml === null) return { data: {}, body: text };
  const doc = parseYaml(yaml);
  const data = doc.toJS() ?? {};
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new FrontmatterError('frontmatter must be a mapping');
  }
  return { data, body: rest.replace(/^\r?\n/, '') };
}

export function setFields(text, patch) {
  const { yaml, rest } = split(text);
  const doc = yaml === null ? parseDocument('{}') : parseYaml(yaml);
  if (yaml !== null && doc.contents === null) doc.contents = doc.createNode({});
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) doc.delete(k);
    else doc.set(k, v);
  }
  doc.contents.flow = false;
  const block = doc.toString({ lineWidth: 0 }).replace(/\n$/, '');
  const head = block === '{}' ? '---\n---' : `---\n${block}\n---`;
  return yaml === null ? `${head}\n${text}` : head + rest;
}

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;

// Stateful per-line fence tracker: returns true for fence delimiter lines and lines inside a fence.
// A fence closes only on the same marker character, at least as long, with nothing after it.
export function fenceTracker() {
  let open = null;
  return (line) => {
    const m = FENCE.exec(line);
    if (!open) {
      if (m) { open = m[1]; return true; }
      return false;
    }
    if (m && m[1][0] === open[0] && m[1].length >= open.length && m[2].trim() === '') open = null;
    return true;
  };
}

// Locate a level-2 section outside code fences: { start, end } line indexes (end = next #/## heading or EOF).
// `last` picks the final matching heading instead of the first.
export function locateSection(lines, heading, { last = false } = {}) {
  const target = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
  const inFence = fenceTracker();
  let found = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (inFence(lines[i])) continue;
    if (found && found.end === null) {
      if (/^#{1,2}\s/.test(lines[i])) {
        found.end = i;
        if (!last) break;
      }
    }
    if (target.test(lines[i]) && (last || !found)) found = { start: i, end: null };
  }
  return found && { start: found.start, end: found.end ?? lines.length };
}

export function appendToSection(text, heading, line) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const sec = locateSection(lines, heading);
  if (!sec) {
    const body = text.replace(/(\r?\n)*$/, '');
    return `${body}${eol}${eol}## ${heading}${eol}${line}${eol}`;
  }
  const { start, end } = sec;
  let last = end - 1;
  while (last > start && lines[last].trim() === '') last -= 1;
  lines.splice(last + 1, 0, line);
  return lines.join(eol);
}
