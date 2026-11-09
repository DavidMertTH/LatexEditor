import { EditorState, Compartment, StateEffect, StateField, type Extension } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightSpecialChars,
  Decoration,
  type DecorationSet,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap, completionKeymap, startCompletion } from '@codemirror/autocomplete';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { latexSupport } from './language';
import { latexCompletion } from './completion';
import { visualMode, visualConfig, visualBodyStart, type VisualConfig } from './visual';
import { toggleCommand, toggleLineComment } from './format';
import { imageInput, trackPosition, takePosition, clampToBody, insertFigures, type FigureItem } from './images';
import type { LogEntry, ProjectIndex } from '../api';

export type EditorMode = 'source' | 'visual';

export interface ControllerOptions {
  getIndex: () => ProjectIndex | null;
  imageUrl: (path: string) => string;
  onDocChanged: (path: string, content: string) => void;
  onSelection: (path: string, line: number) => void;
  onSave: () => void;
  onCompile: () => void;
  onSyncForward: () => void;
  /** Bilder wurden eingefügt/abgelegt; `ticket` merkt sich die Einfügeposition (siehe insertImages). */
  onImages?: (path: string, files: File[], ticket: number) => void;
}

// line flash used after jumping to a location
const flashEffect = StateEffect.define<number | null>();
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(flashEffect)) {
        value = e.value === null ? Decoration.none : Decoration.set([Decoration.line({ class: 'cm-flash-line' }).range(e.value)]);
      }
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export class EditorController {
  view: EditorView;
  private states = new Map<string, EditorState>();
  current: string | null = null;
  mode: EditorMode = 'source';
  private modeComp = new Compartment();
  private configComp = new Compartment();
  private fontComp = new Compartment();
  private files: string[] = [];
  private diagnostics: LogEntry[] = [];
  private suppress = false;
  private flashTimer = 0;
  fontSize = 13.5;

  constructor(private opts: ControllerOptions) {
    this.view = new EditorView({ state: EditorState.create({ doc: '' }) });
  }

  private visualCfg(): VisualConfig {
    return { imageUrl: this.opts.imageUrl, files: this.files };
  }

  private extensions(path: string): Extension[] {
    const isTex = /\.(tex|sty|cls|ltx|dtx|bib|tikz)$/i.test(path);
    return [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter({ openText: '⌄', closedText: '›' }),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      indentUnit.of('  '),
      bracketMatching(),
      closeBrackets(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      lintGutter(),
      flashField,
      EditorView.lineWrapping,
      isTex ? latexSupport() : [],
      isTex ? latexCompletion(() => ({ index: this.opts.getIndex(), currentFile: this.current ?? '' })) : [],
      /\.(tex|ltx)$/i.test(path) ? imageInput((files, view, pos) => this.handleImages(files, view, pos)) : [],
      this.configComp.of(visualConfig.of(this.visualCfg())),
      this.modeComp.of(this.modeExtension(path)),
      this.fontComp.of(EditorView.theme({ '&': { '--editor-font-size': `${this.fontSize}px` } as Record<string, string> })),
      keymap.of([
        { key: 'Mod-s', run: () => (this.opts.onSave(), true), preventDefault: true },
        { key: 'Mod-Enter', run: () => (this.opts.onCompile(), true), preventDefault: true },
        { key: 'Mod-.', run: () => (this.opts.onSyncForward(), true), preventDefault: true },
        { key: 'Mod-b', run: (v) => toggleCommand(v, 'textbf'), preventDefault: true },
        { key: 'Mod-i', run: (v) => toggleCommand(v, 'textit'), preventDefault: true },
        { key: 'Mod-u', run: (v) => toggleCommand(v, 'underline'), preventDefault: true },
        { key: 'Mod-/', run: toggleLineComment, preventDefault: true },
        { key: 'Ctrl-Space', run: startCompletion },
        ...closeBracketsKeymap,
        ...completionKeymap,
        ...searchKeymap,
        ...foldKeymap,
        ...historyKeymap,
        indentWithTab,
        ...defaultKeymap,
      ]),
      EditorView.updateListener.of((u) => {
        if (!this.current || this.suppress) return;
        if (u.docChanged) this.opts.onDocChanged(this.current, u.state.doc.toString());
        if (u.selectionSet || u.docChanged) this.opts.onSelection(this.current, u.state.doc.lineAt(u.state.selection.main.head).number);
      }),
      EditorView.contentAttributes.of({ spellcheck: 'true', autocorrect: 'off', autocapitalize: 'off', lang: 'de' }),
    ];
  }

  private modeExtension(path: string): Extension {
    return this.mode === 'visual' && /\.tex$/i.test(path) ? visualMode() : [];
  }

  setFiles(files: string[]) {
    this.files = files;
    this.view.dispatch({ effects: this.configComp.reconfigure(visualConfig.of(this.visualCfg())) });
  }

  has(path: string) {
    return this.states.has(path);
  }

  open(path: string, content?: string) {
    if (this.current) this.states.set(this.current, this.view.state);
    let state = this.states.get(path);
    if (!state) {
      state = EditorState.create({ doc: content ?? '', extensions: this.extensions(path) });
      this.states.set(path, state);
    }
    this.current = path;
    this.suppress = true;
    this.view.setState(state);
    this.view.dispatch({
      effects: [this.modeComp.reconfigure(this.modeExtension(path)), this.configComp.reconfigure(visualConfig.of(this.visualCfg())), this.fontComp.reconfigure(this.fontTheme())],
    });
    this.suppress = false;
    this.ensureCursorInBody();
    this.applyDiagnostics();
  }

  close(path: string) {
    this.states.delete(path);
    if (this.current === path) this.current = null;
  }

  rename(from: string, to: string) {
    const s = this.current === from ? this.view.state : this.states.get(from);
    if (!s) return;
    this.states.delete(from);
    this.states.set(to, s);
    if (this.current === from) this.current = to;
  }

  getContent(path: string): string | null {
    if (path === this.current) return this.view.state.doc.toString();
    return this.states.get(path)?.doc.toString() ?? null;
  }

  /** Replace content after an external change, keeping cursor & history. */
  setContent(path: string, content: string) {
    if (path === this.current) {
      const old = this.view.state.doc.toString();
      if (old === content) return;
      const head = Math.min(this.view.state.selection.main.head, content.length);
      this.suppress = true;
      this.view.dispatch({ changes: { from: 0, to: old.length, insert: content }, selection: { anchor: head } });
      this.suppress = false;
    } else if (this.states.has(path)) {
      const s = this.states.get(path)!;
      this.states.set(path, s.update({ changes: { from: 0, to: s.doc.length, insert: content } }).state);
    }
  }

  setMode(mode: EditorMode) {
    this.mode = mode;
    if (!this.current) return;
    this.view.dispatch({ effects: this.modeComp.reconfigure(this.modeExtension(this.current)) });
    this.ensureCursorInBody();
  }

  private fontTheme() {
    return EditorView.theme({ '&': { '--editor-font-size': `${this.fontSize}px` } as Record<string, string> });
  }

  setFontSize(size: number) {
    this.fontSize = size;
    this.view.dispatch({ effects: this.fontComp.reconfigure(this.fontTheme()) });
  }

  private ensureCursorInBody() {
    if (this.mode !== 'visual' || !this.current?.endsWith('.tex')) return;
    const start = visualBodyStart(this.view.state);
    if (start > 0 && this.view.state.selection.main.head < start) {
      this.view.dispatch({ selection: { anchor: Math.min(start, this.view.state.doc.length) } });
    }
  }

  setDiagnostics(entries: LogEntry[]) {
    this.diagnostics = entries;
    this.applyDiagnostics();
  }

  private applyDiagnostics() {
    if (!this.current) return;
    const doc = this.view.state.doc;
    const list: Diagnostic[] = [];
    for (const e of this.diagnostics) {
      if (e.file !== this.current || !e.line || e.line > doc.lines) continue;
      if (e.level === 'typesetting') continue;
      const line = doc.line(e.line);
      list.push({ from: line.from, to: line.to, severity: e.level === 'error' ? 'error' : 'warning', message: e.message });
    }
    this.view.dispatch(setDiagnostics(this.view.state, list));
  }

  gotoLine(line: number, flash = true) {
    const doc = this.view.state.doc;
    const ln = doc.line(Math.max(1, Math.min(line, doc.lines)));
    this.view.dispatch({
      selection: { anchor: ln.from },
      effects: [EditorView.scrollIntoView(ln.from, { y: 'center' }), ...(flash ? [flashEffect.of(ln.from)] : [])],
    });
    this.view.focus();
    clearTimeout(this.flashTimer);
    if (flash) this.flashTimer = window.setTimeout(() => this.view.dispatch({ effects: flashEffect.of(null) }), 1800);
  }

  private handleImages(files: File[], view: EditorView, pos: number): boolean {
    if (!this.current || !this.opts.onImages || view !== this.view) return false;
    const ticket = trackPosition(view, clampToBody(view.state, pos));
    this.opts.onImages(this.current, files, ticket);
    return true;
  }

  /** Snippet für hochgeladene Bilder an der gemerkten Stelle einfügen. false, wenn die Datei inzwischen gewechselt wurde. */
  insertImages(path: string, ticket: number, items: FigureItem[]): boolean {
    if (path !== this.current) return false;
    const pos = takePosition(this.view, ticket);
    if (pos === null) return false;
    if (items.length) insertFigures(this.view, pos, items);
    this.view.focus();
    return true;
  }

  cursorLine(): number {
    return this.view.state.doc.lineAt(this.view.state.selection.main.head).number;
  }

  destroy() {
    this.view.destroy();
  }
}
