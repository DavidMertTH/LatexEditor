import path from 'node:path';
import { existsSync } from 'node:fs';

const FILE_RE = /^(?:"([^"]+)"|([^\s()"]+?\.(?:tex|sty|cls|bbl|aux|cfg|def|clo|fd|ltx|toc|lof|lot|out|bib|tikz|dtx|ind|nav|snm|vrb|mkii|lbx|bbx|cbx|dbx)))/i;

function normalize(file, root) {
  if (!file) return null;
  let f = file.trim().replace(/^"|"$/g, '');
  if (path.isAbsolute(f)) {
    f = path.relative(root, f); // also copes with C:/ vs C:\ and drive-letter case on Windows
    if (f.startsWith('..') || path.isAbsolute(f)) return null; // system files (packages) are not interesting for the editor
  }
  if (path.sep === '\\') f = f.replace(/\\/g, '/');
  f = f.replace(/^\.\//, '');
  if (f.startsWith('.latex-out/')) return null;
  // files outside the project (packages from the TeX distribution) are not editable
  if (!existsSync(path.join(root, f))) return null;
  return f;
}

/**
 * Parse a TeX log into errors, warnings and typesetting (box) issues.
 * Assumes the log was written with max_print_line large (no hard wrapping), but copes with wrapped logs too.
 */
export function parseLog(log, root) {
  const lines = log.split(/\r?\n/);
  const errors = [];
  const warnings = [];
  const typesetting = [];
  const stack = [];
  const seen = new Set();
  const current = () => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i]) return stack[i];
    return null;
  };
  const push = (list, entry) => {
    const key = `${entry.level}|${entry.file}|${entry.line}|${entry.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push(entry);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // file-line-error style: ./main.tex:12: Undefined control sequence.
    const fle = line.match(/^((?:\.{0,2}\/|[A-Za-z]:[\\/])?[^:\s][^:]*\.[a-z]{2,5}):(\d+): (.*)$/i);
    if (fle) {
      const file = normalize(fle[1], root) ?? current();
      let message = fle[3];
      const ctx = collectContext(lines, i + 1);
      if (/LaTeX Error: /.test(message)) message = message.replace(/^.*LaTeX Error: /, '');
      push(errors, { level: 'error', file, line: +fle[2], message: message.trim(), content: ctx.text });
      i = ctx.end - 1;
      continue;
    }

    // Classic error: ! Undefined control sequence.
    if (line.startsWith('! ')) {
      let message = line.slice(2).replace(/^LaTeX Error: /, '');
      const ctx = collectContext(lines, i + 1);
      const lm = ctx.text.match(/^l\.(\d+)/m);
      push(errors, { level: 'error', file: current(), line: lm ? +lm[1] : null, message: message.trim(), content: ctx.text });
      i = ctx.end - 1;
      continue;
    }

    const warn = line.match(/^((?:La|pdf)TeX|Package\s+(\S+)|Class\s+(\S+)|LaTeX\s+Font)\s+Warning:\s*(.*)$/);
    if (warn) {
      let message = warn[4];
      const pkg = warn[2] || warn[3];
      let j = i + 1;
      // continuation lines start with "(pkgname)" or a run of spaces
      while (j < lines.length && lines[j].trim() !== '' && (pkg ? lines[j].startsWith(`(${pkg})`) : /^\s{4,}/.test(lines[j]) || /^\(Font\)/.test(lines[j]))) {
        message += ' ' + lines[j].replace(/^\([^)]*\)\s*/, '').trim();
        j++;
      }
      const lm = message.match(/on input line (\d+)/);
      push(warnings, {
        level: 'warning',
        file: current(),
        line: lm ? +lm[1] : null,
        message: (pkg ? `${pkg}: ` : '') + message.replace(/\s+/g, ' ').trim(),
        content: '',
      });
      i = j - 1;
      continue;
    }

    const box = line.match(/^(Overfull|Underfull) \\([hv])box \(([^)]*)\).*?(?:lines? (\d+)(?:--(\d+))?|detected at line (\d+))?\s*$/);
    if (box) {
      const ln = box[4] || box[6];
      push(typesetting, {
        level: 'typesetting',
        file: current(),
        line: ln ? +ln : null,
        message: `${box[1]} \\${box[2]}box (${box[3]})`,
        content: lines[i + 1] && !lines[i + 1].startsWith('[') ? lines[i + 1].trim() : '',
      });
      continue;
    }

    trackFiles(line, stack, root);
  }
  return { errors, warnings, typesetting };
}

function collectContext(lines, start) {
  let j = start;
  const out = [];
  while (j < lines.length && out.length < 8) {
    const l = lines[j];
    if (l.trim() === '' && out.length > 0) break;
    if (/^(?:\.{0,2}\/|[A-Za-z]:[\\/])?[^:\s][^:]*\.[a-z]{2,5}:\d+: /.test(l) || l.startsWith('! ')) break;
    out.push(l);
    j++;
  }
  return { text: out.join('\n').trim(), end: j };
}

function trackFiles(line, stack, root) {
  for (let k = 0; k < line.length; k++) {
    const ch = line[k];
    if (ch === '(') {
      const rest = line.slice(k + 1);
      const m = rest.match(FILE_RE);
      if (m) {
        stack.push(normalize(m[1] || m[2], root) || '');
        k += m[0].length;
      } else {
        stack.push(null);
      }
    } else if (ch === ')') {
      stack.pop();
    }
  }
}
