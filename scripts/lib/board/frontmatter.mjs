// Read and edit YAML frontmatter on Markdown docs without disturbing the body.
import { parseDocument } from 'yaml';

export class FrontmatterError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FrontmatterError';
  }
}

const FM = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/;

function split(text) {
  const m = FM.exec(text);
  if (!m) return { yaml: null, rest: text };
  return { yaml: m[1], rest: text.slice(m[0].length) };
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

const FENCE = /^\s*(```|~~~)/;

export function appendToSection(text, heading, line) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const target = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
  let inFence = false;
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    if (FENCE.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (start === -1) {
      if (target.test(lines[i])) start = i;
    } else if (/^#{1,2}\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (start === -1) {
    const body = text.replace(/(\r?\n)*$/, '');
    return `${body}${eol}${eol}## ${heading}${eol}${line}${eol}`;
  }
  let last = end - 1;
  while (last > start && lines[last].trim() === '') last -= 1;
  lines.splice(last + 1, 0, line);
  return lines.join(eol);
}
