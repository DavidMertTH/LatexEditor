/**
 * Bilder per Strg+V oder Drag & Drop in den Editor einfügen: erkennt Bilddateien
 * im Clipboard bzw. beim Ablegen, wählt Zielordner und Dateinamen und fügt an der
 * Einfügeposition eine figure-Umgebung mit \includegraphics ein.
 */
import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { indentUnit } from '@codemirror/language';

// ── Dateitypen ──────────────────────────────────────────────────────────────
/** Formate, die pdfLaTeX/XeLaTeX/LuaLaTeX direkt einbinden können. */
const DIRECT = new Set(['png', 'jpg', 'jpeg', 'pdf', 'eps']);
const JPEG_ALIAS = new Set(['jfif', 'jpe', 'pjpeg', 'pjp']);
/** Formate, die der Browser dekodieren kann und die wir nach PNG umwandeln. */
const CONVERT = new Set(['webp', 'gif', 'bmp', 'svg', 'avif', 'ico', 'tif', 'tiff', 'heic']);
const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/x-icon': 'ico',
  'image/tiff': 'tiff',
  'application/pdf': 'pdf',
  'application/postscript': 'eps',
};

function imageExt(file: File): string {
  const m = /\.([a-z0-9]+)$/i.exec(file.name);
  const ext = m?.[1].toLowerCase() ?? '';
  if (DIRECT.has(ext) || JPEG_ALIAS.has(ext) || CONVERT.has(ext)) return ext;
  return MIME_EXT[file.type] ?? '';
}

export function isImageFile(file: File): boolean {
  return imageExt(file) !== '';
}

function filesOf(data: DataTransfer): File[] {
  const out = Array.from(data.files ?? []);
  if (out.length) return out;
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue;
    const f = item.getAsFile();
    if (f) out.push(f);
  }
  return out;
}

/**
 * Bilder aus dem Clipboard. Office-Programme legen beim Kopieren von Text
 * zusätzlich ein Bild ab – liegt echter Text daneben, gewinnt der Text, außer
 * das HTML besteht nur aus einem <img> (z. B. „Bild kopieren“ im Browser).
 */
export function clipboardImages(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = filesOf(data).filter(isImageFile);
  if (!files.length) return [];
  if (data.getData('text/plain').trim()) {
    const html = data.getData('text/html');
    const onlyImage = /<img\b/i.test(html) && !(new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '').trim();
    if (!onlyImage) return [];
  }
  return files;
}

export function droppedImages(data: DataTransfer | null): File[] {
  if (!data?.files?.length) return [];
  return Array.from(data.files).filter(isImageFile);
}

// ── Umwandlung ──────────────────────────────────────────────────────────────
export interface PreparedImage {
  blob: Blob;
  ext: string;
  /** Ursprungsformat, falls nach PNG umgewandelt wurde */
  convertedFrom: string | null;
}

/** Liefert eine Datei, die LaTeX einbinden kann (webp, gif, svg … → PNG). */
export async function prepareImage(file: File): Promise<PreparedImage> {
  const ext = imageExt(file);
  if (DIRECT.has(ext)) return { blob: file, ext, convertedFrom: null };
  if (JPEG_ALIAS.has(ext)) return { blob: file, ext: 'jpg', convertedFrom: null };
  return { blob: await toPng(file, ext === 'svg'), ext: 'png', convertedFrom: ext || 'Bild' };
}

async function toPng(file: File, svg: boolean): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      throw new Error(`Das Format „${imageExt(file) || file.type}“ kann nicht gelesen werden`);
    }
    let w = img.naturalWidth;
    let h = img.naturalHeight;
    if (svg) {
      // Vektorgrafik großzügig rastern, damit sie im PDF scharf bleibt.
      const vb = /viewBox\s*=\s*["']\s*[-\d.e]+[\s,]+[-\d.e]+[\s,]+([\d.e]+)[\s,]+([\d.e]+)/i.exec(await file.text());
      if (vb && (!w || !h)) {
        w = parseFloat(vb[1]);
        h = parseFloat(vb[2]);
      }
      if (!w || !h) [w, h] = [800, 600];
      const scale = Math.min(4, 2400 / Math.max(w, h));
      w = Math.round(w * Math.max(1, scale));
      h = Math.round(h * Math.max(1, scale));
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Umwandlung in PNG fehlgeschlagen'))), 'image/png'),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ── Namen und Pfade ─────────────────────────────────────────────────────────
const UMLAUT: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss' };

/** Dateiname ohne Endung, LaTeX-tauglich (keine Leerzeichen, Umlaute, Punkte). */
export function sanitizeBase(name: string): string {
  return name
    .replace(/[äöüÄÖÜß]/g, (c) => UMLAUT[c])
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 60);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Originalname der Datei oder – bei Bildern aus der Zwischenablage – paste-JJJJ-MM-TT-HHMM. */
export function imageBaseName(file: File, now = new Date()): string {
  const raw = file.name.replace(/\.[^.]*$/, '').trim();
  const generic = /^(image|blob|clipboard|untitled|unbenannt|bild)?$/i.test(raw);
  return (!generic && sanitizeBase(raw)) || `paste-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** Freier Pfad `dir/base.ext` bzw. `dir/base-2.ext` … (taken: Kleinbuchstaben, projektrelativ). */
export function uniquePath(dir: string, base: string, ext: string, taken: Set<string>): string {
  const make = (b: string) => (dir ? `${dir}/${b}.${ext}` : `${b}.${ext}`);
  let p = make(base);
  for (let n = 2; taken.has(p.toLowerCase()); n++) p = make(`${base}-${n}`);
  return p;
}

export function uniqueLabel(base: string, taken: Set<string>): string {
  const stem = `fig:${base}`;
  let label = stem;
  for (let n = 2; taken.has(label); n++) label = `${stem}-${n}`;
  taken.add(label);
  return label;
}

/** Normalisiert einen projektrelativen Pfad; null, wenn er das Projekt verlässt. */
function normalize(p: string): string | null {
  const out: string[] = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join('/');
}

function relative(fromDir: string, to: string): string {
  const a = fromDir ? fromDir.split('/') : [];
  const b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...Array<string>(a.length - i).fill('..'), ...b.slice(i)].join('/');
}

const dirOf = (p: string) => p.split('/').slice(0, -1).join('/');
const stripComments = (src: string) => src.replace(/(^|[^\\])%.*$/gm, '$1');

/** Einträge aus \graphicspath{{a/}{b/}} (wie geschrieben, relativ zum Hauptdokument). */
export function parseGraphicsPath(source: string): string[] {
  const code = stripComments(source);
  const all = [...code.matchAll(/\\graphicspath\s*\{/g)];
  const m = all[all.length - 1];
  if (!m) return [];
  let i = m.index! + m[0].length;
  const start = i;
  for (let depth = 1; i < code.length && depth; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') depth--;
  }
  const inner = code.slice(start, i - 1);
  const groups = [...inner.matchAll(/\{([^{}]*)\}/g)].map((g) => g[1].trim());
  return (groups.length ? groups : [inner.trim()]).filter(Boolean);
}

const IMAGE_DIR_NAMES = ['figures', 'figs', 'fig', 'images', 'imgs', 'img', 'graphics', 'grafiken', 'bilder', 'abbildungen', 'pictures', 'pics', 'plots', 'assets'];
const IMAGE_FILE = /\.(png|jpe?g|pdf|eps|svg|gif|webp)$/i;

export interface ImageTarget {
  /** Zielordner, projektrelativ */
  dir: string;
  /** Verzeichnis des Hauptdokuments, projektrelativ */
  baseDir: string;
  /** \graphicspath-Einträge, projektrelativ */
  graphicsPaths: string[];
}

/**
 * Zielordner für neue Bilder: erster \graphicspath-Eintrag, sonst ein vorhandener
 * Bilder-Ordner (figures/, images/, img/ …), sonst der Ordner mit den meisten
 * Bildern, sonst figures/ (wird beim Hochladen angelegt).
 */
export function imageTarget(mainFile: string, mainSource: string, files: string[], dirs: string[]): ImageTarget {
  const baseDir = dirOf(mainFile);
  const inBase = (p: string) => (baseDir ? `${baseDir}/${p}` : p);
  const graphicsPaths = parseGraphicsPath(mainSource)
    .filter((e) => !/^([a-z]:)?[\\/]/i.test(e)) // absolute Pfade ignorieren
    .map((e) => normalize(inBase(e)))
    .filter((e): e is string => e !== null);
  const fromGp = graphicsPaths.find((g) => g !== baseDir);
  if (fromGp) return { dir: fromGp, baseDir, graphicsPaths };

  const children = dirs.filter((d) => dirOf(d) === baseDir);
  for (const name of IMAGE_DIR_NAMES) {
    const hit = children.find((d) => d.split('/').pop()!.toLowerCase() === name);
    if (hit) return { dir: hit, baseDir, graphicsPaths };
  }

  const counts = new Map<string, number>();
  for (const f of files) {
    const d = dirOf(f);
    if (!IMAGE_FILE.test(f) || d === baseDir || (baseDir && !d.startsWith(baseDir + '/'))) continue;
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  const best = [...counts].sort((a, b) => b[1] - a[1])[0];
  return { dir: best ? best[0] : inBase('figures'), baseDir, graphicsPaths };
}

/** Pfad für \includegraphics: relativ zum Hauptdokument bzw. zum passenden \graphicspath-Eintrag. */
export function includePath(file: string, target: ImageTarget): string {
  for (const g of target.graphicsPaths) if (g && g !== target.baseDir && file.startsWith(g + '/')) return file.slice(g.length + 1);
  return relative(target.baseDir, file);
}

// ── graphicx ────────────────────────────────────────────────────────────────
/** Pakete/Klassen, die graphicx (mit \includegraphics[width=…]) mitbringen. */
const PROVIDES_GRAPHICX = new Set(['graphicx', 'tikz', 'pgf', 'pgfplots', 'svg', 'adjustbox', 'pdfpages', 'overpic', 'graphbox', 'mwe', 'beamer']);

function loads(source: string): string[] {
  const code = stripComments(source);
  const names: string[] = [];
  for (const m of code.matchAll(/\\(?:usepackage|RequirePackage|documentclass|LoadClass)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)) {
    names.push(...m[1].split(',').map((s) => s.trim()).filter(Boolean));
  }
  return names;
}

/** Prüft, ob graphicx geladen wird – auch über projekteigene .sty/.cls-Dateien. */
export async function graphicxLoaded(mainFile: string, mainSource: string, files: string[], read: (path: string) => Promise<string | null>): Promise<boolean> {
  const baseDir = dirOf(mainFile);
  const seen = new Set<string>();
  const queue = [mainSource];
  while (queue.length) {
    for (const name of loads(queue.shift()!)) {
      if (PROVIDES_GRAPHICX.has(name)) return true;
      for (const ext of ['sty', 'cls']) {
        const local = [baseDir ? `${baseDir}/${name}.${ext}` : `${name}.${ext}`, `${name}.${ext}`].find((f) => files.includes(f));
        if (!local || seen.has(local)) continue;
        seen.add(local);
        const src = await read(local);
        if (src) queue.push(src);
      }
    }
  }
  return false;
}

// ── Einfügeposition über asynchrones Hochladen hinweg merken ────────────────
const trackEffect = StateEffect.define<{ id: number; pos: number | null }>();
const pendingInserts = StateField.define<ReadonlyMap<number, number>>({
  create: () => new Map(),
  update(value, tr) {
    let next = value;
    if (tr.docChanged && value.size) {
      const mapped = new Map<number, number>();
      for (const [id, pos] of value) mapped.set(id, tr.changes.mapPos(pos, 1));
      next = mapped;
    }
    for (const e of tr.effects) {
      if (!e.is(trackEffect)) continue;
      const copy = new Map(next);
      if (e.value.pos === null) copy.delete(e.value.id);
      else copy.set(e.value.id, e.value.pos);
      next = copy;
    }
    return next;
  },
});

let nextTicket = 1;

export function trackPosition(view: EditorView, pos: number): number {
  const id = nextTicket++;
  view.dispatch({ effects: trackEffect.of({ id, pos }) });
  return id;
}

/** Gemerkte Position abholen (und freigeben); null, wenn unbekannt. */
export function takePosition(view: EditorView, id: number): number | null {
  const pos = view.state.field(pendingInserts, false)?.get(id);
  if (pos === undefined) return null;
  view.dispatch({ effects: trackEffect.of({ id, pos: null }) });
  return pos;
}

/** Bilder nie in Präambel oder hinter \end{document} einfügen. */
export function clampToBody(state: EditorState, pos: number): number {
  const text = state.doc.toString();
  const begin = /^[^%\n]*?\\begin\{document\}/m.exec(text);
  if (begin) {
    const start = state.doc.lineAt(begin.index + begin[0].length).to;
    if (pos < start) return start;
  }
  const end = /^[^%\n]*?\\end\{document\}/m.exec(text);
  if (end) {
    const line = state.doc.lineAt(end.index + end[0].length);
    if (pos > line.from) return line.from;
  }
  return pos;
}

// ── Snippet ─────────────────────────────────────────────────────────────────
export interface FigureItem {
  path: string;
  label: string;
}

const FIGURE_ENVS = /\\(begin|end)\{(figure\*?|subfigure|wrapfigure|SCfigure|minipage)\}/g;

function insideFigure(before: string): boolean {
  let depth = 0;
  for (const m of stripComments(before).matchAll(FIGURE_ENVS)) depth = Math.max(0, depth + (m[1] === 'begin' ? 1 : -1));
  return depth > 0;
}

/**
 * Fügt an `pos` für jedes Bild eine figure-Umgebung ein (innerhalb einer
 * bestehenden figure nur \includegraphics) und setzt den Cursor in \caption{}.
 */
export function insertFigures(view: EditorView, pos: number, items: FigureItem[]) {
  const { state } = view;
  pos = Math.max(0, Math.min(pos, state.doc.length));
  const unit = state.facet(indentUnit);
  const line = state.doc.lineAt(pos);
  const indent = /^\s*/.exec(line.text)![0];
  const graphic = (it: FigureItem) => `\\includegraphics[width=0.8\\linewidth]{${it.path}}`;

  let block: string;
  if (insideFigure(state.doc.sliceString(Math.max(0, pos - 50000), pos))) {
    block = items.map((it) => indent + graphic(it)).join('\n');
  } else {
    block = items
      .map((it) =>
        [`\\begin{figure}[t]`, `${unit}\\centering`, `${unit}${graphic(it)}`, `${unit}\\caption{}`, `${unit}\\label{${it.label}}`, `\\end{figure}`].map((l) => indent + l).join('\n'),
      )
      .join('\n\n');
  }

  // Ganze Zeilen einfügen: in einer Leerzeile (Absatzgrenze bleibt erhalten),
  // am Zeilenanfang davor, sonst hinter der aktuellen Zeile.
  let from: number;
  let to: number;
  let insert: string;
  let offset: number;
  if (!line.text.trim()) {
    const blank = (n: number) => n < 1 || n > state.doc.lines || !state.doc.line(n).text.trim();
    const lead = blank(line.number - 1) ? '' : '\n';
    // letzte Zeile: abschließenden Zeilenumbruch der Datei erhalten
    const trail = line.number === state.doc.lines || !blank(line.number + 1) ? '\n' : '';
    [from, to, insert, offset] = [line.from, line.to, lead + block + trail, lead.length];
  } else if (pos <= line.from + indent.length) {
    [from, to, insert, offset] = [line.from, line.from, block + '\n', 0];
  } else {
    [from, to, insert, offset] = [line.to, line.to, '\n' + block, 1];
  }
  const caption = block.indexOf('\\caption{}');
  const cursor = from + offset + (caption >= 0 ? caption + '\\caption{'.length : block.length);
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: cursor },
    scrollIntoView: true,
    userEvent: 'input.paste',
  });
}

// ── Editor-Erweiterung ──────────────────────────────────────────────────────
export type ImageHandler = (files: File[], view: EditorView, pos: number) => boolean;

/** Drop-Events, deren Bilder der Editor übernommen hat (für den Fallback in Workspace). */
export const handledDrops = new WeakSet<Event>();

/**
 * Strg+V mit Bild im Clipboard und Ablegen von Bilddateien. Normales Einfügen
 * von Text bleibt unverändert. Drop wird in der Capture-Phase am Editor-Element
 * abgefangen, damit es auch über Widgets des visuellen Modus funktioniert.
 */
export function imageInput(onImages: ImageHandler): Extension {
  const dropPlugin = ViewPlugin.define((view) => {
    const onDrop = (event: DragEvent) => {
      if (event.defaultPrevented) return;
      const files = droppedImages(event.dataTransfer);
      if (!files.length) return;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
      if (!onImages(files, view, pos)) return;
      event.preventDefault();
      handledDrops.add(event);
    };
    view.dom.addEventListener('drop', onDrop, true);
    return { destroy: () => view.dom.removeEventListener('drop', onDrop, true) };
  });
  return [
    pendingInserts,
    dropPlugin,
    EditorView.domEventHandlers({
      paste(event, view) {
        const files = clipboardImages(event.clipboardData);
        if (!files.length) return false;
        if (!onImages(files, view, view.state.selection.main.head)) return false;
        event.preventDefault();
        return true;
      },
    }),
  ];
}
