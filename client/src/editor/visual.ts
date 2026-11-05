/**
 * Visual (WYSIWYM) mode: decorates LaTeX source so it reads like the rendered
 * document while remaining fully editable – similar to Overleaf's Visual Editor.
 * Markup is hidden, math is typeset with KaTeX, lists get bullets, figures show
 * their images, tables are rendered. Moving the cursor into math, references or
 * other atomic elements reveals their source for editing.
 */
import { Facet, StateField, StateEffect, type EditorState, type Range, type Text } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { MATH_ENVS } from './data';
import { extractMacros, matchBrace, normalizeMath, renderMath, renderInline, escapeHtml } from './render';
import { renderPdfThumb } from '../pdf';

export interface VisualConfig {
  imageUrl: (path: string) => string;
  files: string[];
}

export const visualConfig = Facet.define<VisualConfig, VisualConfig>({
  combine: (v) => v[v.length - 1] ?? { imageUrl: (p) => p, files: [] },
});

export const refreshVisual = StateEffect.define<null>();

// ── parsing ───────────────────────────────────────────────────────────────
interface MathItem {
  from: number;
  to: number;
  inner: string;
  display: boolean;
  env?: string;
}
interface CmdItem {
  name: string;
  from: number; // at backslash
  to: number; // after closing brace (or name end)
  argFrom: number; // first char inside braces
  argTo: number; // position of closing brace
  opt?: string;
  arg2?: { from: number; to: number }; // second argument (href)
}
interface Parsed {
  preamble: { from: number; to: number; docclass: string; pkgCount: number } | null;
  ending: { from: number; to: number } | null;
  bodyFrom: number;
  bodyTo: number;
  macros: Record<string, string>;
  title: string;
  author: string;
  date: string;
  theorems: Record<string, string>;
  comments: [number, number][];
  maths: MathItem[];
  tables: { from: number; to: number; spec: string; body: string }[];
  cmds: CmdItem[];
  masked: Uint8Array; // 1 = inside comment/math/verbatim/table relative to bodyFrom
  headings: { level: number; title: string }[];
}

const HEADING_LEVEL: Record<string, number> = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, subparagraph: 6 };
const FORMAT_CLASS: Record<string, string> = {
  textbf: 'vm-bold',
  textit: 'vm-italic',
  textsl: 'vm-italic',
  emph: 'vm-italic',
  underline: 'vm-underline',
  texttt: 'vm-mono',
  textsc: 'vm-smallcaps',
  textsf: 'vm-sans',
  textrm: '',
  textup: '',
  textnormal: '',
  mbox: '',
  enquote: 'vm-quoted',
};
const CHIP_CMDS = /^(cite|citep|citet|citealp|citeauthor|citeyear|parencite|textcite|autocite|footcite|nocite|ref|eqref|autoref|cref|Cref|pageref|nameref|vref|label)$/;
const VERBATIM_ENVS = new Set(['verbatim', 'verbatim*', 'lstlisting', 'minted', 'comment', 'Verbatim']);
const TABLE_ENVS = new Set(['tabular', 'tabular*', 'tabularx', 'longtable', 'tabulary']);
const LIST_ENVS = new Set(['itemize', 'enumerate', 'description']);
const ENV_LABELS: Record<string, string> = {
  abstract: 'Zusammenfassung',
  theorem: 'Satz',
  lemma: 'Lemma',
  proof: 'Beweis',
  definition: 'Definition',
  corollary: 'Korollar',
  remark: 'Bemerkung',
  example: 'Beispiel',
  proposition: 'Proposition',
  conjecture: 'Vermutung',
  frame: 'Folie',
  lstlisting: 'Code',
  minted: 'Code',
  verbatim: 'Verbatim',
  tikzpicture: 'TikZ',
  thebibliography: 'Literatur',
  minipage: 'Minipage',
  subfigure: 'Teilabbildung',
  columns: 'Spalten',
  block: 'Block',
};
const SILENT_ENVS = new Set(['center', 'flushleft', 'flushright', 'figure', 'figure*', 'table', 'table*', 'quote', 'quotation', 'verse', 'document', 'itemize', 'enumerate', 'description', 'wrapfigure', 'small', 'footnotesize']);
const SILENT_LINE = /^\s*\\(centering|noindent|indent|raggedright|raggedleft|vspace\*?\{[^}]*\}|hspace\*?\{[^}]*\}|vfill|hfill|smallskip|medskip|bigskip|bibliographystyle\{[^}]*\}|small|footnotesize|normalsize|large|Large|par|setlength\{[^}]*\}\{[^}]*\}|pagestyle\{[^}]*\}|thispagestyle\{[^}]*\}|addcontentsline\{[^}]*\}\{[^}]*\}\{[^}]*\})\s*(%.*)?$/;

const parseCache = new WeakMap<Text, Parsed>();

function parse(doc: Text): Parsed {
  const hit = parseCache.get(doc);
  if (hit) return hit;
  const text = doc.toString();

  let bodyFrom = 0;
  let preamble: Parsed['preamble'] = null;
  const beginDoc = /^[ \t]*\\begin\{document\}.*$/m.exec(text);
  const preText = beginDoc ? text.slice(0, beginDoc.index) : '';
  if (beginDoc) {
    const lineEnd = beginDoc.index + beginDoc[0].length;
    preamble = {
      from: 0,
      to: lineEnd,
      docclass: /\\documentclass(?:\[[^\]]*\])?\{([^}]*)\}/.exec(preText)?.[1] ?? '',
      pkgCount: [...preText.matchAll(/\\usepackage(?:\[[^\]]*\])?\{([^}]*)\}/g)].reduce((n, m) => n + m[1].split(',').length, 0),
    };
    bodyFrom = Math.min(text.length, lineEnd + 1);
  }
  let ending: Parsed['ending'] = null;
  let bodyTo = text.length;
  const endDoc = /^[ \t]*\\end\{document\}/m.exec(text.slice(bodyFrom));
  if (endDoc) {
    const from = bodyFrom + endDoc.index;
    ending = { from, to: text.length };
    bodyTo = from;
  }

  const getArg = (src: string, cmd: string) => {
    const m = new RegExp(`\\\\${cmd}\\s*(?:\\[[^\\]]*\\])?\\{`).exec(src);
    if (!m) return '';
    const open = m.index + m[0].length - 1;
    const close = matchBrace(src, open);
    return close > 0 ? src.slice(open + 1, close) : '';
  };
  const macros = extractMacros(text);
  const theorems: Record<string, string> = {};
  for (const m of text.matchAll(/\\newtheorem\*?\{([^}]+)\}(?:\[[^\]]*\])?\{([^}]+)\}/g)) theorems[m[1]] = m[2];

  const masked = new Uint8Array(Math.max(0, bodyTo - bodyFrom));
  const mask = (a: number, b: number) => masked.fill(1, Math.max(0, a - bodyFrom), Math.max(0, b - bodyFrom));
  const comments: [number, number][] = [];
  const maths: MathItem[] = [];
  const tables: Parsed['tables'] = [];

  // Scan for comments, math and verbatim regions
  let i = bodyFrom;
  while (i < bodyTo) {
    const c = text.charCodeAt(i);
    if (c === 92 /* \ */) {
      const next = text[i + 1];
      if (text.startsWith('\\begin{', i)) {
        const close = text.indexOf('}', i + 7);
        const name = close > 0 ? text.slice(i + 7, close) : '';
        if (MATH_ENVS.has(name) || VERBATIM_ENVS.has(name) || TABLE_ENVS.has(name)) {
          const endTok = `\\end{${name}}`;
          const endIdx = text.indexOf(endTok, close);
          if (endIdx > 0 && endIdx < bodyTo) {
            const to = endIdx + endTok.length;
            if (MATH_ENVS.has(name)) maths.push({ from: i, to, inner: text.slice(close + 1, endIdx), display: true, env: name });
            else if (TABLE_ENVS.has(name)) {
              let p = close + 1;
              if (name === 'tabular*' || name === 'tabularx' || name === 'tabulary') {
                // width argument
                if (text[p] === '{') p = matchBrace(text, p) + 1;
              }
              while (text[p] === '[') p = matchBrace(text, p, '[', ']') + 1;
              let spec = '';
              if (text[p] === '{') {
                const e = matchBrace(text, p);
                spec = text.slice(p + 1, e);
                p = e + 1;
              }
              tables.push({ from: i, to, spec, body: text.slice(p, endIdx) });
            }
            if (!VERBATIM_ENVS.has(name)) mask(i, to);
            else mask(close + 1, endIdx);
            i = to;
            continue;
          }
        }
        i = close > 0 ? close + 1 : i + 7;
        continue;
      }
      if (next === '[' || next === '(') {
        const endTok = next === '[' ? '\\]' : '\\)';
        const endIdx = text.indexOf(endTok, i + 2);
        if (endIdx > 0 && endIdx < bodyTo) {
          maths.push({ from: i, to: endIdx + 2, inner: text.slice(i + 2, endIdx), display: next === '[' });
          mask(i, endIdx + 2);
          i = endIdx + 2;
          continue;
        }
      }
      i += 2;
      continue;
    }
    if (c === 37 /* % */) {
      let eol = text.indexOf('\n', i);
      if (eol < 0 || eol > bodyTo) eol = bodyTo;
      comments.push([i, eol]);
      mask(i, eol);
      i = eol;
      continue;
    }
    if (c === 36 /* $ */) {
      if (text[i + 1] === '$') {
        const endIdx = text.indexOf('$$', i + 2);
        if (endIdx > 0 && endIdx < bodyTo) {
          maths.push({ from: i, to: endIdx + 2, inner: text.slice(i + 2, endIdx), display: true });
          mask(i, endIdx + 2);
          i = endIdx + 2;
          continue;
        }
        i += 2;
        continue;
      }
      let j = i + 1;
      let found = -1;
      while (j < bodyTo) {
        const cj = text[j];
        if (cj === '\\') {
          j += 2;
          continue;
        }
        if (cj === '$') {
          found = j;
          break;
        }
        if (cj === '\n' && text[j + 1] === '\n') break;
        j++;
      }
      if (found > 0) {
        maths.push({ from: i, to: found + 1, inner: text.slice(i + 1, found), display: false });
        mask(i, found + 1);
        i = found + 1;
        continue;
      }
    }
    i++;
  }

  const isMasked = (pos: number) => pos >= bodyFrom && pos < bodyTo && masked[pos - bodyFrom] === 1;

  // Commands with arguments
  const cmds: CmdItem[] = [];
  const cmdRe = /\\([A-Za-z]+)(\*?)/g;
  cmdRe.lastIndex = bodyFrom;
  let m: RegExpExecArray | null;
  const headings: Parsed['headings'] = [];
  while ((m = cmdRe.exec(text)) && m.index < bodyTo) {
    if (isMasked(m.index)) continue;
    if (m.index > 0 && text[m.index - 1] === '\\' && (m.index < 2 || text[m.index - 2] !== '\\')) continue;
    const name = m[1];
    let p = m.index + m[0].length;
    const known =
      name in HEADING_LEVEL ||
      name in FORMAT_CLASS ||
      CHIP_CMDS.test(name) ||
      /^(footnote|url|href|caption|includegraphics|textcolor|LaTeX|TeX|ldots|dots|today|maketitle|tableofcontents|listoffigures|listoftables|bibliography|printbibliography|newpage|clearpage|pagebreak|item|frametitle|euro|S|copyright|quad|qquad|textbackslash)$/.test(name);
    if (!known) continue;
    let opt: string | undefined;
    // Commands without arguments
    if (/^(LaTeX|TeX|ldots|dots|today|maketitle|tableofcontents|listoffigures|listoftables|printbibliography|newpage|clearpage|pagebreak|item|euro|S|copyright|quad|qquad|textbackslash)$/.test(name)) {
      let to = p;
      if (text.startsWith('{}', to)) to += 2;
      cmds.push({ name, from: m.index, to, argFrom: to, argTo: to });
      continue;
    }
    while (text[p] === ' ') p++;
    if (text[p] === '[') {
      const e = matchBrace(text, p, '[', ']');
      if (e < 0) continue;
      opt = text.slice(p + 1, e);
      p = e + 1;
    }
    if (text[p] !== '{') continue;
    const close = matchBrace(text, p);
    if (close < 0 || close > bodyTo) continue;
    const item: CmdItem = { name: name + m[2], from: m.index, to: close + 1, argFrom: p + 1, argTo: close, opt };
    if (name === 'href' || name === 'textcolor') {
      let q = close + 1;
      if (text[q] === '{') {
        const c2 = matchBrace(text, q);
        if (c2 > 0) {
          item.arg2 = { from: q + 1, to: c2 };
          item.to = c2 + 1;
        }
      }
    }
    if (name in HEADING_LEVEL) headings.push({ level: HEADING_LEVEL[name], title: text.slice(p + 1, close) });
    cmds.push(item);
  }

  const parsed: Parsed = {
    preamble,
    ending,
    bodyFrom,
    bodyTo,
    macros,
    title: getArg(text, 'title'),
    author: getArg(text, 'author'),
    date: getArg(text, 'date'),
    theorems,
    comments,
    maths,
    tables,
    cmds,
    masked,
    headings,
  };
  parseCache.set(doc, parsed);
  return parsed;
}

// ── widgets ───────────────────────────────────────────────────────────────
abstract class ClickWidget extends WidgetType {
  ignoreEvent() {
    return false;
  }
}

class MathWidget extends ClickWidget {
  constructor(
    readonly src: string,
    readonly display: boolean,
    readonly block: boolean,
    readonly macros: Record<string, string>,
    readonly macroKey: string,
  ) {
    super();
  }
  eq(o: MathWidget) {
    return o.src === this.src && o.display === this.display && o.block === this.block && o.macroKey === this.macroKey;
  }
  toDOM() {
    const el = document.createElement(this.block ? 'div' : 'span');
    el.className = this.display ? (this.block ? 'vm-math-block' : 'vm-math-display') : 'vm-math-inline';
    el.innerHTML = renderMath(this.src, this.display, this.macros);
    return el;
  }
}

class MathPreviewWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly macros: Record<string, string>,
    readonly macroKey: string,
  ) {
    super();
  }
  eq(o: MathPreviewWidget) {
    return o.src === this.src && o.macroKey === this.macroKey;
  }
  toDOM() {
    const el = document.createElement('div');
    el.className = 'vm-math-preview';
    el.innerHTML = renderMath(this.src, true, this.macros);
    return el;
  }
}

class ChipWidget extends ClickWidget {
  constructor(
    readonly kind: string,
    readonly text: string,
  ) {
    super();
  }
  eq(o: ChipWidget) {
    return o.kind === this.kind && o.text === this.text;
  }
  toDOM() {
    const el = document.createElement('span');
    const k = /cite/.test(this.kind) ? 'cite' : this.kind === 'label' ? 'label' : 'ref';
    el.className = `vm-chip vm-chip-${k}`;
    const keys = this.text.split(',').map((s) => s.trim());
    if (k === 'cite') el.textContent = `[${keys.join(', ')}]`;
    else if (k === 'label') el.textContent = keys.join(', ');
    else el.textContent = (this.kind === 'eqref' ? '(' : '') + keys.join(', ') + (this.kind === 'eqref' ? ')' : '');
    el.title = `\\${this.kind}{${this.text}}`;
    return el;
  }
}

class TextWidget extends ClickWidget {
  constructor(
    readonly html: string,
    readonly cls = '',
  ) {
    super();
  }
  eq(o: TextWidget) {
    return o.html === this.html && o.cls === this.cls;
  }
  toDOM() {
    const el = document.createElement('span');
    if (this.cls) el.className = this.cls;
    el.innerHTML = this.html;
    return el;
  }
}

class BulletWidget extends ClickWidget {
  constructor(
    readonly label: string,
    readonly kind: 'bullet' | 'number' | 'desc',
  ) {
    super();
  }
  eq(o: BulletWidget) {
    return o.label === this.label && o.kind === this.kind;
  }
  toDOM() {
    const el = document.createElement('span');
    el.className = `vm-bullet vm-bullet-${this.kind}`;
    el.textContent = this.label;
    return el;
  }
}

class HiddenLineWidget extends ClickWidget {
  constructor(readonly source: string) {
    super();
  }
  eq(o: HiddenLineWidget) {
    return o.source === this.source;
  }
  toDOM() {
    const el = document.createElement('div');
    el.className = 'vm-hidden-line';
    el.title = this.source.trim();
    return el;
  }
  get estimatedHeight() {
    return 6;
  }
}

class EnvLabelWidget extends ClickWidget {
  constructor(
    readonly label: string,
    readonly kind: string,
    readonly end: boolean,
  ) {
    super();
  }
  eq(o: EnvLabelWidget) {
    return o.label === this.label && o.kind === this.kind && o.end === this.end;
  }
  toDOM() {
    const el = document.createElement('div');
    el.className = `vm-env-label vm-env-${this.kind}${this.end ? ' vm-env-end' : ''}`;
    if (!this.end) {
      const pill = document.createElement('span');
      pill.innerHTML = this.label;
      el.appendChild(pill);
    } else if (this.kind === 'proof') {
      el.textContent = '∎';
    }
    return el;
  }
}

class BlockHtmlWidget extends ClickWidget {
  constructor(
    readonly html: string,
    readonly cls: string,
  ) {
    super();
  }
  eq(o: BlockHtmlWidget) {
    return o.html === this.html && o.cls === this.cls;
  }
  toDOM() {
    const el = document.createElement('div');
    el.className = this.cls;
    el.innerHTML = this.html;
    return el;
  }
}

class ImageWidget extends ClickWidget {
  constructor(
    readonly url: string,
    readonly isPdf: boolean,
    readonly width: string,
    readonly path: string,
  ) {
    super();
  }
  eq(o: ImageWidget) {
    return o.url === this.url && o.width === this.width;
  }
  toDOM() {
    const wrap = document.createElement('span');
    wrap.className = 'vm-image';
    wrap.style.width = this.width;
    if (!this.url) {
      wrap.classList.add('vm-image-missing');
      wrap.textContent = `Bild nicht gefunden: ${this.path}`;
      return wrap;
    }
    if (this.isPdf) {
      wrap.classList.add('loading');
      renderPdfThumb(this.url, 900)
        .then((canvas) => {
          const img = document.createElement('img');
          img.src = canvas.toDataURL();
          wrap.classList.remove('loading');
          wrap.appendChild(img);
        })
        .catch(() => {
          wrap.classList.remove('loading');
          wrap.classList.add('vm-image-missing');
          wrap.textContent = `PDF konnte nicht geladen werden: ${this.path}`;
        });
    } else {
      const img = document.createElement('img');
      img.src = this.url;
      img.alt = this.path;
      img.onerror = () => {
        wrap.classList.add('vm-image-missing');
        wrap.textContent = `Bild kann nicht angezeigt werden: ${this.path}`;
      };
      wrap.appendChild(img);
    }
    return wrap;
  }
}

// ── decoration building ──────────────────────────────────────────────────
const hide = Decoration.replace({});

function imageWidth(opt: string | undefined): string {
  if (!opt) return '';
  const w = /width\s*=\s*([\d.]*)\s*\\(linewidth|textwidth|columnwidth)/.exec(opt);
  if (w) return `${Math.min(100, (parseFloat(w[1] || '1') || 1) * 100)}%`;
  const s = /scale\s*=\s*([\d.]+)/.exec(opt);
  if (s) return `${Math.min(100, parseFloat(s[1]) * 100)}%`;
  const abs = /width\s*=\s*([\d.]+)\s*(cm|mm|in|pt)/.exec(opt);
  if (abs) {
    const cm = parseFloat(abs[1]) * ({ cm: 1, mm: 0.1, in: 2.54, pt: 0.0353 } as Record<string, number>)[abs[2]];
    return `${Math.min(100, (cm / 16) * 100)}%`;
  }
  return '';
}

function resolveImage(path: string, files: string[]): string | null {
  const clean = path.trim().replace(/^\.\//, '');
  if (files.includes(clean)) return clean;
  for (const ext of ['.pdf', '.png', '.jpg', '.jpeg', '.svg', '.gif', '.eps']) if (files.includes(clean + ext)) return clean + ext;
  const base = clean.split('/').pop()!;
  return files.find((f) => f.endsWith('/' + base) || f.split('/').pop()!.replace(/\.[^.]+$/, '') === base) ?? null;
}

function buildDecorations(state: EditorState): { decorations: DecorationSet; atomic: DecorationSet } {
  const doc = state.doc;
  const p = parse(doc);
  const cfg = state.facet(visualConfig);
  const sel = state.selection.ranges;
  const touches = (from: number, to: number) => sel.some((r) => r.from <= to && r.to >= from);
  const decos: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  const replaced: [number, number][] = [];
  const overlaps = (from: number, to: number) => replaced.some(([a, b]) => from < b && to > a);
  const replace = (from: number, to: number, deco: Decoration) => {
    if (from > to || overlaps(from, to)) return false;
    replaced.push([from, to]);
    decos.push(deco.range(from, to));
    return true;
  };
  const macroKey = Object.keys(p.macros).join(',') + Object.values(p.macros).join('');

  // Preamble & document end
  if (p.preamble && !touches(p.preamble.from, p.preamble.to)) {
    const html = `<span class="vm-pre-icon">⚙︎</span><span><b>Präambel</b> · ${escapeHtml(p.preamble.docclass || 'Dokument')} · ${p.preamble.pkgCount} Pakete</span><span class="vm-pre-hint">Zum Bearbeiten klicken</span>`;
    replace(p.preamble.from, p.preamble.to, Decoration.replace({ block: true, widget: new BlockHtmlWidget(html, 'vm-preamble') }));
  } else if (p.preamble) {
    for (let l = doc.lineAt(p.preamble.from).number; l <= doc.lineAt(p.preamble.to).number; l++) {
      decos.push(Decoration.line({ class: 'vm-source-line' }).range(doc.line(l).from));
    }
  }
  if (p.ending && !touches(p.ending.from, p.ending.to)) {
    const lastLine = doc.lineAt(p.ending.to);
    replace(p.ending.from, lastLine.to, Decoration.replace({ block: true, widget: new BlockHtmlWidget('', 'vm-doc-end') }));
  }

  const lineOf = (pos: number) => doc.lineAt(pos);
  const isWholeLines = (from: number, to: number) => {
    const a = lineOf(from);
    const b = lineOf(to);
    return a.text.slice(0, from - a.from).trim() === '' && b.text.slice(to - b.from).replace(/%.*$/, '').trim() === '';
  };

  // Tables
  for (const t of p.tables) {
    if (touches(t.from, t.to)) {
      decos.push(Decoration.mark({ class: 'vm-src' }).range(t.from, t.to));
      continue;
    }
    const html = renderTable(t.spec, t.body, p.macros);
    if (isWholeLines(t.from, t.to)) {
      replace(lineOf(t.from).from, lineOf(t.to).to, Decoration.replace({ block: true, widget: new BlockHtmlWidget(html, 'vm-table-wrap') }));
    } else {
      replace(t.from, t.to, Decoration.replace({ widget: new TextWidget(html, 'vm-table-wrap inline') }));
    }
  }

  // Math
  for (const m of p.maths) {
    const src = normalizeMath(m.inner, m.env);
    if (touches(m.from, m.to)) {
      decos.push(Decoration.mark({ class: 'vm-src vm-math-src' }).range(m.from, m.to));
      if (m.display && src.trim()) {
        const endLine = lineOf(m.to);
        decos.push(Decoration.widget({ widget: new MathPreviewWidget(src, p.macros, macroKey), block: true, side: 1 }).range(endLine.to));
      }
      continue;
    }
    if (m.display && isWholeLines(m.from, m.to)) {
      replace(lineOf(m.from).from, lineOf(m.to).to, Decoration.replace({ block: true, widget: new MathWidget(src, true, true, p.macros, macroKey) }));
    } else {
      replace(m.from, m.to, Decoration.replace({ widget: new MathWidget(src, m.display, false, p.macros, macroKey) }));
    }
  }

  // Line pass: environments, lists, headings
  const envStack: { name: string; counter: number }[] = [];
  const firstLine = lineOf(p.bodyFrom).number;
  const lastLine = lineOf(Math.max(p.bodyFrom, p.bodyTo - 1)).number;
  const envAtLine = new Map<number, string[]>();
  for (let ln = firstLine; ln <= lastLine && p.bodyTo > p.bodyFrom; ln++) {
    const line = doc.line(ln);
    if (line.from >= p.bodyTo) break;
    const text = line.text;
    const lineTouched = touches(line.from, line.to);
    envAtLine.set(ln, envStack.map((e) => e.name));
    // lines swallowed by a block widget (tables, display math) need no styling
    if (replaced.some(([a, b]) => line.from >= a && line.to <= b)) continue;
    const begin = /^\s*\\begin\{([^}]+)\}(\[[^\]]*\])?(\{[^}]*\})?(.*)$/.exec(text);
    const end = /^\s*\\end\{([^}]+)\}\s*(%.*)?$/.exec(text);

    // classes for lines inside environments
    const classes: string[] = [];
    let listDepth = 0;
    for (const e of envStack) {
      if (LIST_ENVS.has(e.name)) listDepth++;
      else classes.push('vm-in-' + envClass(e.name, p.theorems));
    }

    if (begin && !TABLE_ENVS.has(begin[1]) && !MATH_ENVS.has(begin[1])) {
      const name = begin[1];
      const rest = (begin[4] || '').trim();
      envStack.push({ name, counter: 0 });
      if (lineTouched || (rest && !/^%/.test(rest) && !/^\\label\{[^}]*\}$/.test(rest))) {
        decos.push(Decoration.line({ class: 'vm-source-line' }).range(line.from));
        continue;
      }
      const label = envLabel(name, p.theorems, begin[2], begin[3]);
      const widget = label ? new EnvLabelWidget(label, envClass(name, p.theorems), false) : new HiddenLineWidget(text);
      replace(line.from, line.to, Decoration.replace({ block: true, widget }));
      continue;
    }
    if (end && !TABLE_ENVS.has(end[1]) && !MATH_ENVS.has(end[1])) {
      const idx = envStack.map((e) => e.name).lastIndexOf(end[1]);
      if (idx >= 0) envStack.splice(idx);
      if (lineTouched) {
        decos.push(Decoration.line({ class: 'vm-source-line' }).range(line.from));
        continue;
      }
      const kind = envClass(end[1], p.theorems);
      const widget = kind === 'proof' ? new EnvLabelWidget('', 'proof', true) : new HiddenLineWidget(text);
      replace(line.from, line.to, Decoration.replace({ block: true, widget }));
      continue;
    }

    if (SILENT_LINE.test(text)) {
      if (!lineTouched) replace(line.from, line.to, Decoration.replace({ block: true, widget: new HiddenLineWidget(text) }));
      else decos.push(Decoration.line({ class: 'vm-source-line' }).range(line.from));
      continue;
    }

    // headings
    const head = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*?)\s*(\[[^\]]*\])?\{/.exec(text);
    if (head) classes.push('vm-h', 'vm-h-' + head[1]);

    // list items
    if (listDepth > 0) {
      const top = [...envStack].reverse().find((e) => LIST_ENVS.has(e.name))!;
      const item = /^(\s*)\\item\b\s*(\[([^\]]*)\])?\s?/.exec(text);
      const style = `--vm-indent:${listDepth * 1.6}em`;
      if (item) {
        top.counter++;
        classes.push('vm-li');
        const from = line.from;
        const to = line.from + item[0].length;
        {
          const label =
            top.name === 'enumerate'
              ? enumLabel(top.counter, listDepth)
              : top.name === 'description'
                ? item[3] ?? ''
                : item[3] ?? ['•', '–', '∗', '·'][(listDepth - 1) % 4];
          const kind = top.name === 'enumerate' ? 'number' : top.name === 'description' ? 'desc' : 'bullet';
          if (replace(from, to, Decoration.replace({ widget: new BulletWidget(label, kind) }))) atomic.push(Decoration.mark({}).range(from, to));
        }
      } else {
        classes.push('vm-li-cont');
        // hide leading indentation in list continuation lines
        const ws = /^\s+/.exec(text);
        if (ws && !lineTouched) replace(line.from, line.from + ws[0].length, hide);
      }
      decos.push(Decoration.line({ class: classes.join(' '), attributes: { style } }).range(line.from));
      continue;
    }
    if (classes.length) decos.push(Decoration.line({ class: classes.join(' ') }).range(line.from));
    // trim leading indentation inside environments for a cleaner look
    if (envStack.length > 0 && !lineTouched) {
      const ws = /^\s+/.exec(text);
      if (ws && ws[0].length < text.length) replace(line.from, line.from + ws[0].length, hide);
    }
  }

  // Commands
  for (const c of p.cmds) {
    if (overlaps(c.from, c.to)) continue;
    const base = c.name.replace(/\*$/, '');
    const touched = touches(c.from, c.to);
    const ln = lineOf(c.from);
    const wholeLine = isWholeLines(c.from, c.to);

    if (base in HEADING_LEVEL) {
      replace(c.from, c.argFrom, hide);
      replace(c.argTo, c.to, hide);
      continue;
    }
    if (base in FORMAT_CLASS) {
      replace(c.from, c.argFrom, hide);
      replace(c.argTo, c.to, hide);
      const cls = FORMAT_CLASS[base];
      if (cls && c.argTo > c.argFrom) decos.push(Decoration.mark({ class: cls }).range(c.argFrom, c.argTo));
      continue;
    }
    if (CHIP_CMDS.test(base)) {
      if (touched) {
        decos.push(Decoration.mark({ class: 'vm-src' }).range(c.from, c.to));
        continue;
      }
      replace(c.from, c.to, Decoration.replace({ widget: new ChipWidget(base, doc.sliceString(c.argFrom, c.argTo)) }));
      continue;
    }
    switch (base) {
      case 'footnote': {
        replace(c.from, c.argFrom, Decoration.replace({ widget: new TextWidget('', 'vm-footnote-mark') }));
        replace(c.argTo, c.to, hide);
        decos.push(Decoration.mark({ class: 'vm-footnote' }).range(c.argFrom, c.argTo));
        break;
      }
      case 'url': {
        replace(c.from, c.argFrom, hide);
        replace(c.argTo, c.to, hide);
        decos.push(Decoration.mark({ class: 'vm-link' }).range(c.argFrom, c.argTo));
        replaced.push([c.argFrom, c.argTo]); // keep URLs verbatim (no typographic replacements)
        break;
      }
      case 'href': {
        if (!c.arg2) break;
        replace(c.from, c.arg2.from, hide);
        replace(c.arg2.to, c.to, hide);
        decos.push(Decoration.mark({ class: 'vm-link', attributes: { title: doc.sliceString(c.argFrom, c.argTo) } }).range(c.arg2.from, c.arg2.to));
        break;
      }
      case 'textcolor': {
        if (!c.arg2) break;
        const color = doc.sliceString(c.argFrom, c.argTo);
        replace(c.from, c.arg2.from, hide);
        replace(c.arg2.to, c.to, hide);
        if (/^[a-zA-Z]+$/.test(color)) decos.push(Decoration.mark({ attributes: { style: `color:${color}` } }).range(c.arg2.from, c.arg2.to));
        break;
      }
      case 'caption':
      case 'frametitle': {
        const envs = envAtLine.get(ln.number) ?? [];
        const label = base === 'frametitle' ? '' : envs.some((e) => e.startsWith('table')) ? 'Tabelle: ' : 'Abbildung: ';
        replace(c.from, c.argFrom, Decoration.replace({ widget: new TextWidget(label, 'vm-caption-label') }));
        replace(c.argTo, c.to, hide);
        decos.push(Decoration.mark({ class: base === 'caption' ? 'vm-caption' : 'vm-frametitle' }).range(c.from, c.to));
        if (wholeLine) decos.push(Decoration.line({ class: base === 'caption' ? 'vm-caption-line' : 'vm-frametitle-line' }).range(ln.from));
        break;
      }
      case 'includegraphics': {
        if (touched) {
          decos.push(Decoration.mark({ class: 'vm-src' }).range(c.from, c.to));
          break;
        }
        const raw = doc.sliceString(c.argFrom, c.argTo);
        const file = resolveImage(raw, cfg.files);
        const url = file ? cfg.imageUrl(file) : '';
        replace(c.from, c.to, Decoration.replace({ widget: new ImageWidget(url, !!file && /\.pdf$/i.test(file), imageWidth(c.opt), raw) }));
        break;
      }
      case 'maketitle': {
        if (touched || !wholeLine) break;
        const html = `<div class="vm-title">${renderInline(p.title, p.macros) || 'Ohne Titel'}</div>${p.author ? `<div class="vm-author">${renderInline(p.author, p.macros)}</div>` : ''}<div class="vm-date">${p.date ? renderInline(p.date, p.macros) : renderInline('\\today', p.macros)}</div>`;
        replace(ln.from, ln.to, Decoration.replace({ block: true, widget: new BlockHtmlWidget(html, 'vm-titleblock') }));
        break;
      }
      case 'tableofcontents': {
        if (touched || !wholeLine) break;
        const items = p.headings
          .filter((h) => h.level <= 3)
          .map((h) => `<div class="vm-toc-item" style="padding-left:${Math.max(0, h.level - 1) * 1.1}em">${renderInline(h.title, p.macros)}</div>`)
          .join('');
        replace(ln.from, ln.to, Decoration.replace({ block: true, widget: new BlockHtmlWidget(`<div class="vm-toc-title">Inhaltsverzeichnis</div>${items || '<div class="vm-toc-item">—</div>'}`, 'vm-toc') }));
        break;
      }
      case 'listoffigures':
      case 'listoftables':
      case 'bibliography':
      case 'printbibliography': {
        if (touched || !wholeLine) break;
        const label = { listoffigures: 'Abbildungsverzeichnis', listoftables: 'Tabellenverzeichnis', bibliography: 'Literaturverzeichnis', printbibliography: 'Literaturverzeichnis' }[base];
        replace(ln.from, ln.to, Decoration.replace({ block: true, widget: new BlockHtmlWidget(`<span>${label}</span>`, 'vm-placeholder') }));
        break;
      }
      case 'newpage':
      case 'clearpage':
      case 'pagebreak': {
        if (touched || !wholeLine) break;
        replace(ln.from, ln.to, Decoration.replace({ block: true, widget: new BlockHtmlWidget('<span>Seitenumbruch</span>', 'vm-pagebreak') }));
        break;
      }
      case 'item':
        break;
      default: {
        if (touched) break;
        const html = renderInline('\\' + base + '{}', p.macros);
        if (html) replace(c.from, c.to, Decoration.replace({ widget: new TextWidget(html, 'vm-symbol') }));
      }
    }
  }

  // Small typographic niceties in plain text
  const body = doc.sliceString(p.bodyFrom, p.bodyTo);
  const typo = /\\\\(\[[^\]]*\])?|---|--|``|''|~|\\[%&$#_{}]|\\,/g;
  let t: RegExpExecArray | null;
  while ((t = typo.exec(body))) {
    const from = p.bodyFrom + t.index;
    const to = from + t[0].length;
    if (p.masked[t.index] || overlaps(from, to) || touches(from, to)) continue;
    let html: string;
    const s = t[0];
    if (s.startsWith('\\\\')) html = '<span class="vm-linebreak">↵</span>';
    else if (s === '---') html = '—';
    else if (s === '--') html = '–';
    else if (s === '``') html = '“';
    else if (s === "''") html = '”';
    else if (s === '~') html = '&nbsp;';
    else if (s === '\\,') html = '&thinsp;';
    else html = escapeHtml(s[1]);
    replace(from, to, Decoration.replace({ widget: new TextWidget(html, 'vm-typo') }));
  }

  // Comments
  for (const [from, to] of p.comments) {
    if (overlaps(from, to)) continue;
    decos.push(Decoration.mark({ class: 'vm-comment' }).range(from, to));
  }

  return { decorations: Decoration.set(decos, true), atomic: Decoration.set(atomic, true) };
}

/** Where the document body starts (after \begin{document}), for placing the cursor in visual mode. */
export function visualBodyStart(state: EditorState): number {
  return parse(state.doc).bodyFrom;
}

function envClass(name: string, theorems: Record<string, string>): string {
  const n = name.replace(/\*$/, '');
  if (n === 'proof') return 'proof';
  if (n === 'abstract') return 'abstract';
  if (n === 'center' || n === 'figure' || n === 'table' || n === 'wrapfigure' || n === 'subfigure') return 'center';
  if (n === 'flushright') return 'right';
  if (n === 'quote' || n === 'quotation' || n === 'verse') return 'quote';
  if (VERBATIM_ENVS.has(name)) return 'verbatim';
  if (n in theorems || /^(theorem|lemma|definition|corollary|remark|example|proposition|conjecture|satz|defn|thm|lem|cor|bsp)$/.test(n)) return 'theorem';
  if (n === 'frame') return 'frame';
  return 'generic';
}

function envLabel(name: string, theorems: Record<string, string>, opt?: string, arg?: string): string | null {
  const n = name.replace(/\*$/, '');
  if (SILENT_ENVS.has(name) || SILENT_ENVS.has(n)) return null;
  const extra = opt ? ` <em>${escapeHtml(opt.slice(1, -1))}</em>` : arg && n === 'frame' ? ` · ${escapeHtml(arg.slice(1, -1))}` : '';
  const base = theorems[n] ?? ENV_LABELS[n] ?? n;
  return escapeHtml(base) + extra;
}

function enumLabel(n: number, depth: number) {
  if (depth === 2) return `(${String.fromCharCode(96 + n)})`;
  if (depth === 3) return `${['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'][n - 1] ?? n}.`;
  return `${n}.`;
}

function renderTable(spec: string, body: string, macros: Record<string, string>): string {
  const aligns = [...spec.replace(/\{[^}]*\}/g, '').replace(/[|@!>< ]/g, '')].map((c) => (c === 'r' ? 'right' : c === 'c' ? 'center' : 'left'));
  const cleaned = body.replace(/(^|[^\\])%.*$/gm, '$1');
  const rows = cleaned.split(/\\\\(?:\[[^\]]*\])?/);
  let html = '<table class="vm-table">';
  for (let r = 0; r < rows.length; r++) {
    let row = rows[r];
    const ruleTop = /\\(toprule|hline|midrule|bottomrule)/.test(row);
    row = row.replace(/\\(toprule|midrule|bottomrule|hline|cline\{[^}]*\}|cmidrule(\([^)]*\))?\{[^}]*\}|rowcolor\{[^}]*\})/g, '').trim();
    if (!row) continue;
    const cells = row.split(/(?<!\\)&/);
    html += `<tr${ruleTop ? ' class="rule"' : ''}>`;
    cells.forEach((cell, i) => {
      const mc = /^\s*\\multicolumn\{(\d+)\}\{([^}]*)\}/.exec(cell);
      const span = mc ? ` colspan="${mc[1]}"` : '';
      const align = mc ? (/r/.test(mc[2]) ? 'right' : /c/.test(mc[2]) ? 'center' : 'left') : aligns[i] ?? 'left';
      html += `<td${span} style="text-align:${align}">${renderInline(cell.trim(), macros)}</td>`;
    });
    html += '</tr>';
  }
  return html + '</table>';
}

export const visualField = StateField.define<{ decorations: DecorationSet; atomic: DecorationSet }>({
  create: (state) => buildDecorations(state),
  update(value, tr) {
    if (tr.docChanged || tr.selection || tr.effects.some((e) => e.is(refreshVisual)) || tr.startState.facet(visualConfig) !== tr.state.facet(visualConfig)) {
      return buildDecorations(tr.state);
    }
    return value;
  },
  provide: (f) => [EditorView.decorations.from(f, (v) => v.decorations), EditorView.atomicRanges.of((view) => view.state.field(f).atomic)],
});

/** Clicking a block widget should move the cursor into the element so its source is revealed. */
const revealOnClick = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = (event.target as HTMLElement).closest('.vm-preamble, .vm-math-block, .vm-table-wrap, .vm-titleblock, .vm-toc, .vm-placeholder, .vm-pagebreak, .vm-env-label, .vm-hidden-line, .vm-doc-end, .vm-image');
    if (!target) return false;
    const pos = view.posAtDOM(target);
    event.preventDefault();
    view.dispatch({ selection: { anchor: Math.min(pos + 1, view.state.doc.length) }, scrollIntoView: false });
    view.focus();
    return true;
  },
});

export function visualMode() {
  return [visualField, revealOnClick, EditorView.lineWrapping, EditorView.editorAttributes.of({ class: 'cm-visual' })];
}
