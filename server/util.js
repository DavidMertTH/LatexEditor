import fs from 'node:fs/promises';
import path from 'node:path';

export const TEXT_EXTENSIONS = new Set([
  '.tex', '.bib', '.cls', '.sty', '.bst', '.bbx', '.cbx', '.txt', '.md', '.csv',
  '.dtx', '.ins', '.ltx', '.latex', '.tikz', '.pgf', '.json', '.yaml', '.yml',
  '.lua', '.py', '.r', '.m', '.svg', '.gitignore', '.latexmkrc', '.def', '.cfg', '.clo', '.fd', '.asy', '.gp', '.dat',
]);

export const IGNORED_NAMES = new Set(['.latex-out', '.git', 'node_modules', '.DS_Store', '.latexeditor.json', '.trash']);

export function isTextFile(p) {
  const base = path.basename(p).toLowerCase();
  const ext = path.extname(base);
  if (!ext) return ['makefile', 'readme', 'license', '.latexmkrc', '.gitignore'].includes(base);
  return TEXT_EXTENSIONS.has(ext);
}

export function encodeId(absPath) {
  return Buffer.from(absPath, 'utf8').toString('base64url');
}

export function decodeId(id) {
  return Buffer.from(String(id), 'base64url').toString('utf8');
}

/** Resolve a project-relative path and refuse anything that escapes the project root. */
export function safeJoin(root, rel = '') {
  const cleaned = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
  const abs = path.resolve(root, cleaned);
  const rootResolved = path.resolve(root);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
    const err = new Error('Pfad liegt außerhalb des Projekts');
    err.status = 400;
    throw err;
  }
  return abs;
}

export async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(p, fallback) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function writeJson(p, data) {
  await fs.writeFile(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export async function walk(root, rel = '') {
  const dir = path.join(root, rel);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (IGNORED_NAMES.has(e.name)) continue;
    if (e.name.startsWith('.') && e.name !== '.latexmkrc') continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push({ type: 'dir', name: e.name, path: childRel, children: await walk(root, childRel) });
    } else if (e.isFile()) {
      out.push({ type: 'file', name: e.name, path: childRel });
    }
  }
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'de', { numeric: true }) : a.type === 'dir' ? -1 : 1));
  return out;
}

export function flatten(tree, acc = []) {
  for (const n of tree) {
    if (n.type === 'file') acc.push(n.path);
    else flatten(n.children, acc);
  }
  return acc;
}
