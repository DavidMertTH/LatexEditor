import katex from 'katex';

const MACRO_CACHE = new Map<string, Record<string, string>>();

/** Extract \newcommand / \DeclareMathOperator definitions for KaTeX. */
export function extractMacros(text: string): Record<string, string> {
  const key = text.length + ':' + text.slice(0, 4000);
  const cached = MACRO_CACHE.get(key);
  if (cached) return cached;
  const macros: Record<string, string> = {};
  const re = /\\(?:re)?newcommand\*?\s*\{?\\([A-Za-z]+)\}?\s*(?:\[(\d)\])?\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length - 1;
    const end = matchBrace(text, start);
    if (end < 0) continue;
    macros['\\' + m[1]] = text.slice(start + 1, end);
  }
  const op = /\\DeclareMathOperator(\*?)\s*\{\\([A-Za-z]+)\}\s*\{([^}]*)\}/g;
  while ((m = op.exec(text))) macros['\\' + m[2]] = `\\operatorname${m[1]}{${m[3]}}`;
  if (MACRO_CACHE.size > 20) MACRO_CACHE.clear();
  MACRO_CACHE.set(key, macros);
  return macros;
}

/** Index of the brace matching the "{" at `open`, honouring escapes and nesting. -1 if none. */
export function matchBrace(text: string, open: number, openCh = '{', closeCh = '}'): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '%') {
      const nl = text.indexOf('\n', i);
      if (nl < 0) return -1;
      i = nl;
      continue;
    }
    if (c === openCh) depth++;
    else if (c === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const ENV_MAP: Record<string, string> = {
  align: 'aligned',
  'align*': 'aligned',
  flalign: 'aligned',
  'flalign*': 'aligned',
  eqnarray: 'aligned',
  'eqnarray*': 'aligned',
  alignat: 'alignedat',
  'alignat*': 'alignedat',
  gather: 'gathered',
  'gather*': 'gathered',
  multline: 'gathered',
  'multline*': 'gathered',
};

export function normalizeMath(src: string, env?: string): string {
  let s = src
    .replace(/\\label\s*\{[^}]*\}/g, '')
    .replace(/\\(nonumber|notag)\b/g, '')
    .replace(/\\tag\*?\s*\{[^}]*\}/g, '')
    .replace(/(^|[^\\])%.*$/gm, '$1');
  if (env && ENV_MAP[env]) s = `\\begin{${ENV_MAP[env]}}${s}\\end{${ENV_MAP[env]}}`;
  return s.trim();
}

const RENDER_CACHE = new Map<string, string>();

export function renderMath(src: string, display: boolean, macros: Record<string, string>): string {
  const key = (display ? 'D' : 'I') + JSON.stringify(macros).length + src;
  const hit = RENDER_CACHE.get(key);
  if (hit) return hit;
  let html: string;
  try {
    html = katex.renderToString(src || '\\square', {
      displayMode: display,
      throwOnError: false,
      strict: 'ignore',
      trust: false,
      macros: { ...macros },
      errorColor: 'var(--red)',
    });
  } catch (e) {
    html = `<span class="vm-math-error">${escapeHtml(src)}</span>`;
  }
  if (RENDER_CACHE.size > 800) RENDER_CACHE.clear();
  RENDER_CACHE.set(key, html);
  return html;
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

const SIMPLE: Record<string, string> = {
  LaTeX: 'L<sup style="font-size:.75em;margin-left:-.3em;margin-right:-.1em;vertical-align:.25em">A</sup>T<sub style="vertical-align:-.25em;margin-left:-.1em;margin-right:-.1em;font-size:1em">E</sub>X',
  TeX: 'T<sub style="vertical-align:-.25em;margin-left:-.1em;margin-right:-.1em;font-size:1em">E</sub>X',
  ldots: '…',
  dots: '…',
  textendash: '–',
  textemdash: '—',
  euro: '€',
  S: '§',
  copyright: '©',
  newline: '<br>',
  quad: '&emsp;',
  qquad: '&emsp;&emsp;',
  centering: '',
  noindent: '',
  par: ' ',
  hfill: ' ',
  and: '<br>',
};

/** Very small LaTeX → HTML converter for captions, table cells and titles. */
export function renderInline(src: string, macros: Record<string, string>): string {
  let out = '';
  let i = 0;
  const s = src.replace(/(^|[^\\])%.*$/gm, '$1');
  while (i < s.length) {
    const c = s[i];
    if (c === '$') {
      const dbl = s[i + 1] === '$';
      const close = s.indexOf(dbl ? '$$' : '$', i + (dbl ? 2 : 1));
      if (close > 0) {
        out += renderMath(s.slice(i + (dbl ? 2 : 1), close), false, macros);
        i = close + (dbl ? 2 : 1);
        continue;
      }
    }
    if (c === '\\') {
      const m = /^\\([A-Za-z]+)\*?|^\\(.)/.exec(s.slice(i));
      if (!m) {
        i++;
        continue;
      }
      if (m[2]) {
        if (m[2] === '\\') out += '<br>';
        else if (m[2] === ',' || m[2] === ' ' || m[2] === ';') out += '&thinsp;';
        else if (m[2] === '(') {
          const close = s.indexOf('\\)', i);
          if (close > 0) {
            out += renderMath(s.slice(i + 2, close), false, macros);
            i = close + 2;
            continue;
          }
        } else out += escapeHtml(m[2]);
        i += m[0].length;
        continue;
      }
      const name = m[1];
      i += m[0].length;
      if (name === 'today') {
        out += new Date().toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
        continue;
      }
      if (name in SIMPLE) {
        out += SIMPLE[name];
        if (s[i] === '{' && s[i + 1] === '}') i += 2;
        continue;
      }
      // skip optional arg
      while (s[i] === ' ') i++;
      if (s[i] === '[') {
        const e = matchBrace(s, i, '[', ']');
        if (e > 0) i = e + 1;
      }
      if (s[i] === '{') {
        const e = matchBrace(s, i);
        if (e > 0) {
          const inner = s.slice(i + 1, e);
          i = e + 1;
          const tag = (
            {
              textbf: 'b',
              mathbf: 'b',
              textit: 'i',
              emph: 'em',
              textsl: 'i',
              underline: 'u',
              texttt: 'code',
              textsc: 'span style="font-variant:small-caps"',
              textsuperscript: 'sup',
              textsubscript: 'sub',
            } as Record<string, string>
          )[name];
          if (tag) {
            out += `<${tag}>${renderInline(inner, macros)}</${tag.split(' ')[0]}>`;
          } else if (/^(label|cite|ref|footnote|thanks|vspace|hspace|color|includegraphics|multicolumn|multirow|cline)$/.test(name)) {
            if (name === 'multicolumn' || name === 'multirow') {
              // \multicolumn{n}{spec}{text}: render last argument
              let rest = inner;
              for (let k = 0; k < 2 && s[i] === '{'; k++) {
                const e2 = matchBrace(s, i);
                rest = s.slice(i + 1, e2);
                i = e2 + 1;
              }
              out += renderInline(rest, macros);
            } else if (name === 'cite') out += `<span class="vm-chip-inline">[${escapeHtml(inner)}]</span>`;
            else if (name === 'ref') out += `<span class="vm-chip-inline">${escapeHtml(inner)}</span>`;
          } else {
            out += renderInline(inner, macros);
          }
        }
      }
      continue;
    }
    if (c === '~') {
      out += '&nbsp;';
      i++;
      continue;
    }
    if (c === '{' || c === '}') {
      i++;
      continue;
    }
    if (c === '-' && s.startsWith('---', i)) {
      out += '—';
      i += 3;
      continue;
    }
    if (c === '-' && s.startsWith('--', i)) {
      out += '–';
      i += 2;
      continue;
    }
    if (s.startsWith('``', i)) {
      out += '“';
      i += 2;
      continue;
    }
    if (s.startsWith("''", i)) {
      out += '”';
      i += 2;
      continue;
    }
    out += escapeHtml(c);
    i++;
  }
  return out;
}
