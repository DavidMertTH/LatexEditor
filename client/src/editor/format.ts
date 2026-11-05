import { EditorSelection, type ChangeSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { snippet } from '@codemirror/autocomplete';
import { matchBrace } from './render';

/** Wrap each selection in \cmd{…}; unwrap if it is already wrapped. */
export function toggleCommand(view: EditorView, cmd: string) {
  const { state } = view;
  const prefix = `\\${cmd}{`;
  const tr = state.changeByRange((range) => {
    // Already wrapped? (cursor/selection directly inside \cmd{…})
    const text = state.doc.toString();
    const searchFrom = Math.max(0, range.from - 2000);
    const before = text.slice(searchFrom, range.from);
    const idx = before.lastIndexOf(prefix);
    if (idx >= 0) {
      const open = searchFrom + idx + prefix.length - 1;
      const close = matchBrace(text, open);
      if (close >= range.to && close - open < 4000) {
        const changes: ChangeSpec[] = [
          { from: searchFrom + idx, to: open + 1, insert: '' },
          { from: close, to: close + 1, insert: '' },
        ];
        return {
          changes,
          range: EditorSelection.range(range.anchor - prefix.length, range.head - prefix.length),
        };
      }
    }
    const inner = state.sliceDoc(range.from, range.to);
    return {
      changes: { from: range.from, to: range.to, insert: `${prefix}${inner}}` },
      range: range.empty
        ? EditorSelection.cursor(range.from + prefix.length)
        : EditorSelection.range(range.from + prefix.length, range.to + prefix.length),
    };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input' }));
  view.focus();
  return true;
}

export const HEADING_LEVELS = [
  { id: 'text', label: 'Fließtext' },
  { id: 'part', label: 'Teil' },
  { id: 'chapter', label: 'Kapitel' },
  { id: 'section', label: 'Abschnitt' },
  { id: 'subsection', label: 'Unterabschnitt' },
  { id: 'subsubsection', label: 'Unter-Unterabschnitt' },
  { id: 'paragraph', label: 'Paragraph' },
];

const HEADING_RE = /^(\s*)\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*?)\s*\{(.*)\}(.*)$/;

export function currentHeading(view: EditorView): string {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const m = HEADING_RE.exec(line.text);
  return m ? m[2] : 'text';
}

export function setHeading(view: EditorView, level: string) {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const m = HEADING_RE.exec(line.text);
  const content = m ? m[4] : line.text.trim();
  const indent = m ? m[1] : /^\s*/.exec(line.text)![0];
  const insert = level === 'text' ? indent + content + (m ? m[5] : '') : `${indent}\\${level}${m ? m[3] : ''}{${content}}${m ? m[5] : ''}`;
  const cursor = level === 'text' ? line.from + indent.length + content.length : line.from + indent.length + level.length + 2 + (m ? m[3].length : 0) + content.length;
  view.dispatch({ changes: { from: line.from, to: line.to, insert }, selection: { anchor: cursor }, scrollIntoView: true, userEvent: 'input' });
  view.focus();
}

export function insertSnippet(view: EditorView, template: string) {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  // ${sel} in the template is replaced by the current selection
  const tpl = template.replace('${sel}', selected ? selected.replace(/[{}]/g, (c) => '\\' + c) : '${}');
  snippet(tpl)(view, { label: '' }, from, to);
  view.focus();
}

export function insertList(view: EditorView, env: 'itemize' | 'enumerate') {
  const { state } = view;
  const { from, to } = state.selection.main;
  const lineFrom = state.doc.lineAt(from);
  const lineTo = state.doc.lineAt(to);
  const indent = /^\s*/.exec(lineFrom.text)![0];
  if (from !== to) {
    const lines = state.sliceDoc(lineFrom.from, lineTo.to).split('\n').filter((l) => l.trim());
    const insert = `${indent}\\begin{${env}}\n${lines.map((l) => `${indent}  \\item ${l.trim()}`).join('\n')}\n${indent}\\end{${env}}`;
    view.dispatch({ changes: { from: lineFrom.from, to: lineTo.to, insert }, userEvent: 'input' });
    view.focus();
    return;
  }
  const atEmpty = lineFrom.text.trim() === '';
  const tpl = `${atEmpty ? '' : '\n'}\\begin{${env}}\n\t\\item \${}\n\\end{${env}}\n`;
  if (atEmpty) view.dispatch({ selection: { anchor: lineFrom.from } });
  insertSnippet(view, tpl);
}

export function toggleLineComment(view: EditorView) {
  const { state } = view;
  const lines = new Set<number>();
  for (const r of state.selection.ranges) {
    for (let l = state.doc.lineAt(r.from).number; l <= state.doc.lineAt(r.to).number; l++) lines.add(l);
  }
  const all = [...lines].map((n) => state.doc.line(n));
  const commented = all.every((l) => /^\s*%/.test(l.text) || !l.text.trim());
  const changes = all.map((l) => {
    if (commented) {
      const m = /^(\s*)% ?/.exec(l.text);
      return m ? { from: l.from + m[1].length, to: l.from + m[0].length, insert: '' } : { from: l.from, insert: '' };
    }
    return { from: l.from, insert: '% ' };
  });
  view.dispatch({ changes, userEvent: 'input' });
  return true;
}
