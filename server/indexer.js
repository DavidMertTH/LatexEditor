import fs from 'node:fs/promises';
import path from 'node:path';
import { walk, flatten } from './util.js';

/** Collect labels, bibliography keys, user commands and files for autocompletion. */
export async function buildIndex(root) {
  const files = flatten(await walk(root));
  const labels = [];
  const bib = [];
  const commands = [];
  const environments = [];
  const packages = new Set();

  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (ext !== '.tex' && ext !== '.bib' && ext !== '.sty' && ext !== '.cls') continue;
    let text;
    try {
      text = await fs.readFile(path.join(root, f), 'utf8');
    } catch {
      continue;
    }
    if (text.length > 5_000_000) continue;
    if (ext === '.bib') {
      for (const m of text.matchAll(/@(\w+)\s*\{\s*([^,\s]+)\s*,([\s\S]*?)(?=\n\s*@|\s*$)/g)) {
        if (/^(string|comment|preamble)$/i.test(m[1])) continue;
        const body = m[3];
        const field = (name) => {
          const fm = body.match(new RegExp(`\\b${name}\\s*=\\s*(?:\\{((?:[^{}]|\\{[^{}]*\\})*)\\}|"([^"]*)"|(\\w+))`, 'i'));
          return fm ? (fm[1] ?? fm[2] ?? fm[3] ?? '').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim() : '';
        };
        bib.push({ key: m[2], type: m[1].toLowerCase(), title: field('title'), author: field('author'), year: field('year') || field('date').slice(0, 4), file: f });
      }
      continue;
    }
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const code = line.replace(/(^|[^\\])%.*$/, '$1');
      for (const m of code.matchAll(/\\label\{([^}]+)\}/g)) {
        labels.push({ label: m[1], file: f, line: i + 1, context: labelContext(lines, i) });
      }
      for (const m of code.matchAll(/\\(?:re)?newcommand\*?\s*\{?\\([A-Za-z@]+)\}?\s*(?:\[(\d)\])?/g)) {
        commands.push({ name: m[1], args: m[2] ? +m[2] : 0, file: f });
      }
      for (const m of code.matchAll(/\\(?:DeclareMathOperator|def)\*?\s*\{?\\([A-Za-z@]+)\}?/g)) {
        commands.push({ name: m[1], args: 0, file: f });
      }
      for (const m of code.matchAll(/\\(?:re)?newenvironment\*?\s*\{([^}]+)\}|\\newtheorem\*?\{([^}]+)\}/g)) {
        environments.push({ name: m[1] || m[2], file: f });
      }
      for (const m of code.matchAll(/\\usepackage(?:\[[^\]]*\])?\{([^}]+)\}/g)) {
        for (const p of m[1].split(',')) packages.add(p.trim());
      }
    });
  }
  return { files, labels, bib, commands, environments, packages: [...packages] };
}

function labelContext(lines, i) {
  // Find a nearby heading/caption/environment for a human friendly description
  for (let k = i; k >= Math.max(0, i - 6); k--) {
    const l = lines[k];
    const sec = l.match(/\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\{([^}]*)\}/);
    if (sec) return `${sec[1]}: ${sec[2]}`;
    const cap = l.match(/\\caption(?:\[[^\]]*\])?\{([^}]*)/);
    if (cap) return `Abbildung/Tabelle: ${cap[1]}`;
    const env = l.match(/\\begin\{(equation|align|gather|multline|figure|table|theorem|lemma|definition|lstlisting)\*?\}/);
    if (env) return env[1];
  }
  for (let k = i; k <= Math.min(lines.length - 1, i + 4); k++) {
    const cap = lines[k].match(/\\caption(?:\[[^\]]*\])?\{([^}]*)/);
    if (cap) return `Abbildung/Tabelle: ${cap[1]}`;
  }
  return '';
}
