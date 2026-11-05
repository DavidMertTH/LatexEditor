import { StreamLanguage, HighlightStyle, syntaxHighlighting, foldService, indentService } from '@codemirror/language';
import type { StringStream } from '@codemirror/language';
import { Tag, tags as t } from '@lezer/highlight';
import { MATH_ENVS } from './data';

// Custom highlight tags for LaTeX
export const latexTags = {
  command: Tag.define(),
  mathCommand: Tag.define(),
  math: Tag.define(),
  mathDelim: Tag.define(),
  env: Tag.define(),
  envName: Tag.define(),
  heading: Tag.define(),
  headingCommand: Tag.define(),
  refArg: Tag.define(),
  escape: Tag.define(),
  brace: Tag.define(),
  optArg: Tag.define(),
  align: Tag.define(),
  comment: Tag.define(t.comment),
  bold: Tag.define(),
  italic: Tag.define(),
};

type ArgKind = 'heading' | 'ref' | 'env' | 'bold' | 'italic' | null;

interface State {
  math: null | '$' | '$$' | '\\(' | '\\[' | string; // string = env name
  verbatim: string | null;
  pendingArg: ArgKind; // what the next {…} argument means
  argStack: ArgKind[]; // kind of each open brace
  inOpt: number;
}

const HEADINGS = /^(part|chapter|section|subsection|subsubsection|paragraph|subparagraph|title|caption|frametitle)\*?$/;
const REFS = /^(label|ref|eqref|pageref|autoref|cref|Cref|nameref|vref|cite|citep|citet|parencite|textcite|autocite|footcite|nocite|citeauthor|citeyear|input|include|includegraphics|bibliography|addbibresource|usepackage|documentclass|url|href)$/;
const VERBATIM = new Set(['verbatim', 'verbatim*', 'lstlisting', 'minted', 'comment', 'Verbatim']);

function currentArg(state: State): ArgKind {
  for (let i = state.argStack.length - 1; i >= 0; i--) if (state.argStack[i]) return state.argStack[i];
  return null;
}

function token(stream: StringStream, state: State): string | null {
  // Verbatim-like environments: everything until \end{name}
  if (state.verbatim) {
    const end = `\\end{${state.verbatim}}`;
    if (stream.match(end, false)) {
      stream.match('\\end');
      state.verbatim = null;
      state.pendingArg = 'env';
      return 'env';
    }
    if (!stream.skipTo('\\end{' + state.verbatim + '}')) stream.skipToEnd();
    return 'verbatim';
  }

  const ch = stream.peek();
  if (ch === '%') {
    stream.skipToEnd();
    return 'comment';
  }

  if (ch === '\\') {
    stream.next();
    if (stream.match(/^[A-Za-z@]+\*?/)) {
      const name = stream.current().slice(1);
      if (name === 'begin' || name === 'end') {
        state.pendingArg = 'env';
        return 'env';
      }
      if (HEADINGS.test(name)) {
        state.pendingArg = 'heading';
        return 'headingCommand';
      }
      if (REFS.test(name)) state.pendingArg = 'ref';
      else if (name === 'textbf' || name === 'mathbf') state.pendingArg = 'bold';
      else if (name === 'textit' || name === 'emph') state.pendingArg = 'italic';
      else state.pendingArg = null;
      return state.math ? 'mathCommand' : 'command';
    }
    // \( \[ \) \]
    const next = stream.next();
    if (next === '(' || next === '[') {
      if (!state.math) {
        state.math = '\\' + next;
        return 'mathDelim';
      }
    }
    if ((next === ')' && state.math === '\\(') || (next === ']' && state.math === '\\[')) {
      state.math = null;
      return 'mathDelim';
    }
    if (next === '\\') return 'align';
    return 'escape';
  }

  if (ch === '$') {
    if (stream.match('$$')) {
      if (state.math === '$$') state.math = null;
      else if (!state.math) state.math = '$$';
      return 'mathDelim';
    }
    stream.next();
    if (state.math === '$') state.math = null;
    else if (!state.math) state.math = '$';
    return 'mathDelim';
  }

  if (ch === '{') {
    stream.next();
    state.argStack.push(state.pendingArg);
    state.pendingArg = null;
    return 'brace';
  }
  if (ch === '}') {
    stream.next();
    state.argStack.pop();
    return 'brace';
  }
  if (ch === '[' && state.pendingArg !== null && !state.math) {
    // optional argument: keep pendingArg for the following {…}
    stream.next();
    state.inOpt++;
    return 'optArg';
  }
  if (ch === ']' && state.inOpt > 0) {
    stream.next();
    state.inOpt--;
    return 'optArg';
  }
  if (ch === '&') {
    stream.next();
    return 'align';
  }

  // environment name inside \begin{…}
  const arg = currentArg(state);
  if (arg === 'env') {
    const m = stream.match(/^[^}\s]+/) as RegExpMatchArray | null;
    if (m) {
      const name = m[0];
      const beginOrEnd = stream.string.slice(0, stream.start).match(/\\(begin|end)\{\s*$/);
      if (beginOrEnd) {
        if (beginOrEnd[1] === 'begin') {
          if (MATH_ENVS.has(name) && !state.math) state.math = name;
          if (VERBATIM.has(name)) state.verbatim = name;
        } else if (state.math === name) {
          state.math = null;
        }
      }
      return 'envName';
    }
  }

  if (inOptOnly(state)) {
    stream.next();
    return 'optArg';
  }

  // plain text run
  state.pendingArg = null;
  stream.next();
  stream.eatWhile(/[^\\%${}&\[\]]/);
  if (state.math) return 'math';
  if (arg === 'heading') return 'heading';
  if (arg === 'ref') return 'refArg';
  if (arg === 'bold') return 'bold';
  if (arg === 'italic') return 'italic';
  return null;
}

function inOptOnly(state: State) {
  return state.inOpt > 0 && !state.math;
}

export const latexLanguage = StreamLanguage.define<State>({
  name: 'latex',
  startState: () => ({ math: null, verbatim: null, pendingArg: null, argStack: [], inOpt: 0 }),
  copyState: (s) => ({ ...s, argStack: s.argStack.slice() }),
  token,
  blankLine: (state) => {
    // paragraphs end inline math in TeX
    if (state.math === '$') state.math = null;
  },
  tokenTable: {
    command: latexTags.command,
    mathCommand: latexTags.mathCommand,
    math: latexTags.math,
    mathDelim: latexTags.mathDelim,
    env: latexTags.env,
    envName: latexTags.envName,
    heading: latexTags.heading,
    headingCommand: latexTags.headingCommand,
    refArg: latexTags.refArg,
    escape: latexTags.escape,
    brace: latexTags.brace,
    optArg: latexTags.optArg,
    align: latexTags.align,
    comment: latexTags.comment,
    verbatim: t.monospace,
    bold: latexTags.bold,
    italic: latexTags.italic,
  },
  languageData: {
    commentTokens: { line: '%' },
    closeBrackets: { brackets: ['{', '[', '(', '$'] },
  },
});

export const latexHighlight = HighlightStyle.define([
  { tag: latexTags.command, color: 'var(--syn-command)' },
  { tag: latexTags.mathCommand, color: 'var(--syn-math)', fontWeight: '500' },
  { tag: latexTags.math, color: 'var(--syn-math)' },
  { tag: latexTags.mathDelim, color: 'var(--syn-math)', fontWeight: '600' },
  { tag: latexTags.env, color: 'var(--syn-env)', fontWeight: '500' },
  { tag: latexTags.envName, color: 'var(--syn-env)' },
  { tag: latexTags.headingCommand, color: 'var(--syn-command)', fontWeight: '600' },
  { tag: latexTags.heading, color: 'var(--syn-heading)', fontWeight: '700' },
  { tag: latexTags.refArg, color: 'var(--syn-arg)' },
  { tag: latexTags.escape, color: 'var(--syn-command)' },
  { tag: latexTags.brace, color: 'var(--syn-bracket)' },
  { tag: latexTags.optArg, color: 'var(--syn-number)' },
  { tag: latexTags.align, color: 'var(--syn-bracket)', fontWeight: '600' },
  { tag: latexTags.comment, color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: latexTags.bold, fontWeight: '700' },
  { tag: latexTags.italic, fontStyle: 'italic' },
  { tag: t.monospace, color: 'var(--text-2)' },
]);

/** Fold \begin{x}…\end{x} and sectioning blocks. */
export const latexFolding = foldService.of((state, lineStart, lineEnd) => {
  const line = state.doc.sliceString(lineStart, lineEnd);
  const begin = line.match(/\\begin\{([^}]+)\}/);
  if (begin) {
    const name = begin[1];
    let depth = 0;
    for (let n = state.doc.lineAt(lineStart).number; n <= state.doc.lines; n++) {
      const l = state.doc.line(n);
      const text = n === state.doc.lineAt(lineStart).number ? l.text.slice(begin.index!) : l.text;
      const re = new RegExp(`\\\\(begin|end)\\{${name.replace(/[*]/g, '\\*')}\\}`, 'g');
      let m;
      while ((m = re.exec(text))) {
        depth += m[1] === 'begin' ? 1 : -1;
        if (depth === 0) {
          if (n === state.doc.lineAt(lineStart).number) return null;
          return { from: lineEnd, to: state.doc.line(n - 1).to };
        }
      }
      if (n - state.doc.lineAt(lineStart).number > 3000) break;
    }
    return null;
  }
  const sec = line.match(/^\s*\\(part|chapter|section|subsection|subsubsection|paragraph)\*?[\[{]/);
  if (sec) {
    const levels = ['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph'];
    const lvl = levels.indexOf(sec[1]);
    const startLine = state.doc.lineAt(lineStart).number;
    let endLine = state.doc.lines;
    for (let n = startLine + 1; n <= state.doc.lines; n++) {
      const t2 = state.doc.line(n).text;
      const m = t2.match(/^\s*\\(part|chapter|section|subsection|subsubsection|paragraph)\*?[\[{]/);
      if ((m && levels.indexOf(m[1]) <= lvl) || /^\s*\\end\{document\}/.test(t2) || /^\s*\\(bibliography|printbibliography)\b/.test(t2)) {
        endLine = n - 1;
        break;
      }
    }
    while (endLine > startLine && state.doc.line(endLine).text.trim() === '') endLine--;
    if (endLine <= startLine) return null;
    return { from: lineEnd, to: state.doc.line(endLine).to };
  }
  return null;
});

/** Simple indentation: inside \begin…\end one level deeper. */
export const latexIndent = indentService.of((ctx, pos) => {
  const line = ctx.lineAt(pos, -1);
  const prev = line.text;
  const base = /^\s*/.exec(prev)![0].replace(/\t/g, ' '.repeat(ctx.state.tabSize)).length;
  const unit = ctx.unit;
  const next = ctx.state.doc.lineAt(pos).text.trimStart();
  let indent = base;
  if (/\\begin\{(?!document\})[^}]+\}/.test(prev) && !/\\end\{/.test(prev)) indent += unit;
  if (/^\\end\{/.test(next)) indent -= unit;
  return Math.max(0, indent);
});

export function latexSupport() {
  return [latexLanguage, syntaxHighlighting(latexHighlight), latexFolding, latexIndent];
}
