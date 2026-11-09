import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  PanelLeft,
  Play,
  ChevronDown,
  Settings2,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  FilePlus,
  FolderPlus,
  Upload,
  X,
  Code2,
  Columns2,
  FileText,
  ArrowRight,
  ArrowLeft,
  Square,
  Sun,
  Moon,
  Monitor,
  ChevronRight,
} from 'lucide-react';
import { api, type CompileResult, type Engine, type LogEntry, type ProjectIndex, type Settings, type TreeNode } from '../api';
import { EditorController, type EditorMode } from '../editor/controller';
import { currentHeading } from '../editor/format';
import { FileTree, fileIcon } from './FileTree';
import { FormatBar } from './FormatBar';
import { PdfViewer, type PdfViewerHandle } from './PdfViewer';
import { LogPanel } from './LogPanel';
import { GitPanel, GitPill, useGitSync } from './GitSync';
import { Menu, Popover, Segmented, usePersistentState, useDialogs, modKey, type ThemePref } from '../ui';
import { dirs, flatten } from '../tree';
import { graphicxLoaded, handledDrops, imageBaseName, imageTarget, includePath, isImageFile, prepareImage, uniqueLabel, uniquePath, type FigureItem } from '../editor/images';

type Layout = 'editor' | 'split' | 'pdf';
type OutlineItem = { level: number; title: string; line: number };

const BINARY = /\.(png|jpe?g|gif|webp|svg|pdf|eps|ico|bmp|zip|gz)$/i;
const LEVELS: Record<string, number> = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, addpart: 0, addchap: 1, addsec: 2, minisec: 5 };

function computeOutline(text: string): OutlineItem[] {
  const out: OutlineItem[] = [];
  const lines = text.split('\n');
  lines.forEach((l, i) => {
    const m = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph|addpart|addchap|addsec|minisec)\*?\s*(?:\[[^\]]*\])?\{(.*)\}/.exec(l);
    if (m) out.push({ level: LEVELS[m[1]], title: m[2].replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1').replace(/[{}\\$]/g, '') || '…', line: i + 1 });
    const fm = /^\s*\\begin\{frame\}(?:\[[^\]]*\])?\{([^}]*)\}/.exec(l);
    if (fm) out.push({ level: 3, title: fm[1], line: i + 1 });
  });
  return out;
}

export function Workspace({ projectId, onClose, theme, setTheme }: { projectId: string; onClose: () => void; theme: ThemePref; setTheme: (t: ThemePref) => void }) {
  const { toast, prompt, confirm } = useDialogs();
  const [name, setName] = useState('');
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [engines, setEngines] = useState<Engine[]>([]);
  const [openFiles, setOpenFiles] = usePersistentState<string[]>(`folio.open.${projectId}`, []);
  const [active, setActive] = usePersistentState<string | null>(`folio.active.${projectId}`, null);
  const [layout, setLayout] = usePersistentState<Layout>('folio.layout', 'split');
  const [mode, setMode] = usePersistentState<EditorMode>('folio.mode', 'source');
  const [split, setSplit] = usePersistentState('folio.split', 0.5);
  const [sidebar, setSidebar] = usePersistentState('folio.sidebar', true);
  const [fontSize, setFontSize] = usePersistentState('folio.fontSize', 13.5);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [savingCount, setSavingCount] = useState(0);
  const [compiling, setCompiling] = useState(false);
  const [result, setResult] = useState<CompileResult | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfFile, setPdfFile] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [cursorLine, setCursorLine] = useState(1);
  const [heading, setHeadingState] = useState('text');
  const [settingsAnchor, setSettingsAnchor] = useState<HTMLElement | null>(null);
  const [compileMenu, setCompileMenu] = useState<HTMLElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [gitAnchor, setGitAnchor] = useState<HTMLElement | null>(null);
  const [gitOpen, setGitOpen] = usePersistentState('folio.gitPanel', true);
  const [, force] = useState(0);

  const hostRef = useRef<HTMLDivElement>(null);
  const panesRef = useRef<HTMLDivElement>(null);
  const pdfRef = useRef<PdfViewerHandle>(null);
  const indexRef = useRef<ProjectIndex | null>(null);
  const saveTimers = useRef(new Map<string, number>());
  const compileTimer = useRef(0);
  const compilingRef = useRef(false);
  const queuedRef = useRef(false);
  const settingsRef = useRef<Settings | null>(null);
  const activeRef = useRef<string | null>(active);
  const outlineTimer = useRef(0);
  const indexTimer = useRef(0);
  settingsRef.current = settings;
  activeRef.current = active;

  const files = useMemo(() => flatten(tree), [tree]);
  const isBinary = !!active && BINARY.test(active);
  const isTex = !!active && /\.tex$/i.test(active);

  // ── index (labels, citations, files) ───────────────────────────────────
  const refreshIndex = useCallback(() => {
    clearTimeout(indexTimer.current);
    indexTimer.current = window.setTimeout(() => {
      api.index(projectId).then((idx) => (indexRef.current = idx)).catch(() => {});
    }, 400);
  }, [projectId]);

  // ── editor controller ───────────────────────────────────────────────────
  const controller = useMemo(
    () =>
      new EditorController({
        getIndex: () => indexRef.current,
        imageUrl: (p) => api.rawUrl(projectId, p),
        onDocChanged: (path, content) => {
          setDirty((d) => (d.has(path) ? d : new Set(d).add(path)));
          scheduleSave(path);
          clearTimeout(outlineTimer.current);
          outlineTimer.current = window.setTimeout(() => setOutline(computeOutline(content)), 250);
        },
        onSelection: (_path, line) => {
          setCursorLine(line);
          setHeadingState(currentHeading(controller.view));
        },
        onSave: () => saveAll(true),
        onCompile: () => saveAll(true),
        onSyncForward: () => syncForward(),
        onImages: (path, files, ticket) => insertImages(path, files, ticket),
      }),
    [projectId],
  );
  useEffect(() => () => controller.destroy(), [controller]);

  useEffect(() => {
    const host = hostRef.current;
    if (host && !host.contains(controller.view.dom)) host.appendChild(controller.view.dom);
  });

  useEffect(() => controller.setMode(mode), [mode, controller]);
  useEffect(() => controller.setFontSize(fontSize), [fontSize, controller]);
  useEffect(() => controller.setFiles(files), [files, controller]);

  // ── saving ──────────────────────────────────────────────────────────────
  const doSave = useCallback(
    async (path: string) => {
      clearTimeout(saveTimers.current.get(path));
      saveTimers.current.delete(path);
      const content = controller.getContent(path);
      if (content === null) return;
      setSavingCount((c) => c + 1);
      try {
        await api.writeFile(projectId, path, content);
        setDirty((d) => {
          if (!d.has(path)) return d;
          const n = new Set(d);
          n.delete(path);
          return n;
        });
      } catch (e) {
        toast(`Speichern fehlgeschlagen: ${(e as Error).message}`, 'error');
      } finally {
        setSavingCount((c) => c - 1);
      }
    },
    [projectId, controller],
  );

  function scheduleSave(path: string) {
    clearTimeout(saveTimers.current.get(path));
    saveTimers.current.set(
      path,
      window.setTimeout(async () => {
        await doSave(path);
        refreshIndex();
        if (settingsRef.current?.autoCompile && /\.(tex|bib|sty|cls)$/i.test(path)) scheduleCompile();
      }, 600),
    );
  }

  async function flushSaves() {
    await Promise.all([...saveTimers.current.keys()].map((p) => doSave(p)));
  }

  async function saveAll(andCompile: boolean) {
    await flushSaves();
    refreshIndex();
    if (andCompile) compile(true);
  }

  function scheduleCompile() {
    clearTimeout(compileTimer.current);
    compileTimer.current = window.setTimeout(() => compile(), 900);
  }

  // ── compile ─────────────────────────────────────────────────────────────
  async function compile(manual = false) {
    clearTimeout(compileTimer.current);
    if (compilingRef.current) {
      queuedRef.current = true;
      return;
    }
    compilingRef.current = true;
    setCompiling(true);
    try {
      await flushSaves();
      const res = await api.compile(projectId);
      setResult(res);
      if (res.pdf) {
        setPdfFile(res.pdf);
        setPdfUrl(api.outputUrl(projectId, res.pdf, res.pdfVersion));
      }
      controller.setDiagnostics([...res.errors, ...res.warnings]);
      if (res.status === 'error') {
        toast(res.message ?? 'Kompilierung fehlgeschlagen', 'error');
        setLogOpen(true);
      } else if (res.status === 'failure' && manual) setLogOpen(true);
    } catch (e) {
      toast(`Kompilierung fehlgeschlagen: ${(e as Error).message}`, 'error');
    } finally {
      compilingRef.current = false;
      setCompiling(false);
      if (queuedRef.current) {
        queuedRef.current = false;
        compile(manual);
      }
    }
  }

  const cancelCompile = () => api.cancel(projectId).catch(() => {});

  // ── files ───────────────────────────────────────────────────────────────
  const openFile = useCallback(
    async (path: string, line?: number) => {
      if (!BINARY.test(path) && !controller.has(path)) {
        try {
          const { content } = await api.readFile(projectId, path);
          if (!controller.has(path)) controller.open(path, content);
        } catch (e) {
          toast(`Datei kann nicht geöffnet werden: ${(e as Error).message}`, 'error');
          return;
        }
      }
      if (!BINARY.test(path)) {
        controller.open(path);
        setOutline(computeOutline(controller.getContent(path) ?? ''));
        setCursorLine(controller.cursorLine());
        setHeadingState(currentHeading(controller.view));
      }
      setActive(path);
      setOpenFiles((f) => (f.includes(path) ? f : [...f, path]));
      if (line) setTimeout(() => controller.gotoLine(line), 0);
      else if (!BINARY.test(path)) setTimeout(() => controller.view.focus(), 0);
    },
    [projectId, controller],
  );

  const closeTab = async (path: string) => {
    if (saveTimers.current.has(path)) await doSave(path);
    const idx = openFiles.indexOf(path);
    const next = openFiles.filter((f) => f !== path);
    setOpenFiles(next);
    controller.close(path);
    if (active === path) {
      const n = next[Math.min(idx, next.length - 1)];
      if (n) openFile(n);
      else setActive(null);
    }
  };

  const refreshTree = useCallback(() => {
    api
      .tree(projectId)
      .then(setTree)
      .catch(() => {});
    refreshIndex();
  }, [projectId]);

  const newFile = async (dir: string) => {
    const name = await prompt({ title: 'Neue Datei', message: dir ? `In „${dir}“` : 'Im Projektordner', value: 'kapitel.tex', confirm: 'Erstellen' });
    if (!name) return;
    const path = dir ? `${dir}/${name}` : name;
    try {
      const r = await api.fs(projectId, 'create', path, { content: name.endsWith('.tex') ? `% ${name}\n\n` : '' });
      setTree(r.tree);
      openFile(path);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const newFolder = async (dir: string) => {
    const name = await prompt({ title: 'Neuer Ordner', value: 'bilder', confirm: 'Erstellen' });
    if (!name) return;
    try {
      const r = await api.fs(projectId, 'mkdir', dir ? `${dir}/${name}` : name);
      setTree(r.tree);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const renamePath = async (from: string, to: string) => {
    try {
      if (saveTimers.current.has(from)) await doSave(from);
      const r = await api.fs(projectId, 'rename', from, { to });
      setTree(r.tree);
      // update open tabs (files and files inside renamed folders)
      const mapPath = (p: string) => (p === from ? to : p.startsWith(from + '/') ? to + p.slice(from.length) : p);
      for (const f of openFiles) if (mapPath(f) !== f) controller.rename(f, mapPath(f));
      setOpenFiles((fs) => fs.map(mapPath));
      if (active) setActive(mapPath(active));
      if (settings?.mainFile && mapPath(settings.mainFile) !== settings.mainFile) setSettings({ ...settings, mainFile: mapPath(settings.mainFile) });
      refreshIndex();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const deletePath = async (path: string) => {
    const ok = await confirm({ title: `„${path}“ löschen?`, message: 'Die Datei wird in den Papierkorb des Projekts (.trash) verschoben.', confirm: 'Löschen', danger: true });
    if (!ok) return;
    try {
      const r = await api.fs(projectId, 'delete', path);
      setTree(r.tree);
      for (const f of openFiles) if (f === path || f.startsWith(path + '/')) await closeTab(f);
      refreshIndex();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const upload = async (dir: string, list: FileList | File[]) => {
    const arr = Array.from(list);
    try {
      for (const f of arr) await api.upload(projectId, dir ? `${dir}/${f.name}` : f.name, f);
      toast(arr.length === 1 ? `„${arr[0].name}“ hinzugefügt` : `${arr.length} Dateien hinzugefügt`, 'success');
      refreshTree();
      return arr.map((f) => (dir ? `${dir}/${f.name}` : f.name));
    } catch (e) {
      toast((e as Error).message, 'error');
      return [];
    }
  };

  const updateSettings = async (s: Partial<Settings>) => {
    try {
      const next = await api.saveSettings(projectId, s);
      setSettings(next);
      if (s.engine || s.mainFile) compile();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  // ── SyncTeX ─────────────────────────────────────────────────────────────
  async function syncForward() {
    const file = activeRef.current;
    if (!file || !file.endsWith('.tex')) return;
    if (layout === 'editor') setLayout('split');
    try {
      const r = await api.forward(projectId, file, controller.cursorLine());
      if (r) pdfRef.current?.showHighlight({ ...r, key: Date.now() });
      else toast('Keine passende Stelle im PDF gefunden', 'info');
    } catch (e) {
      toast((e as Error).message, 'info');
    }
  }

  const syncInverse = async (page: number, x: number, y: number) => {
    try {
      const r = await api.inverse(projectId, page, x, y);
      if (!r) return;
      if (layout === 'pdf') setLayout('split');
      await openFile(r.file, r.line);
    } catch (e) {
      toast((e as Error).message, 'info');
    }
  };

  // ── files changed by a git pull ─────────────────────────────────────────
  const onPulled = async (paths: string[]) => {
    for (const p of paths) {
      if (!controller.has(p) || saveTimers.current.has(p)) continue;
      const r = await api.readFile(projectId, p).catch(() => null);
      if (!r) continue;
      controller.setContent(p, r.content);
      if (p === activeRef.current) setOutline(computeOutline(r.content));
    }
    refreshTree();
    if (settingsRef.current?.autoCompile && paths.some((p) => /\.(tex|bib|sty|cls|png|jpe?g|pdf)$/i.test(p))) scheduleCompile();
  };

  const git = useGitSync(projectId, () => flushSaves(), onPulled);

  const jumpToEntry = (e: LogEntry) => {
    if (!e.file) return;
    if (layout === 'pdf') setLayout('split');
    openFile(e.file, e.line ?? undefined);
  };

  // ── initial load ───────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    api
      .project(projectId)
      .then(async (p) => {
        if (!alive) return;
        setName(p.name);
        document.title = `${p.name} – Folio`;
        setTree(p.tree);
        setSettings(p.settings);
        setEngines(p.engines);
        const all = flatten(p.tree);
        const validOpen = openFiles.filter((f) => all.includes(f));
        if (!validOpen.includes(p.settings.mainFile) && all.includes(p.settings.mainFile)) validOpen.unshift(p.settings.mainFile);
        setOpenFiles(validOpen);
        const first = active && all.includes(active) ? active : all.includes(p.settings.mainFile) ? p.settings.mainFile : validOpen[0];
        if (first) await openFile(first);
        if (p.hasPdf) {
          const pdf = p.settings.mainFile.split('/').pop()!.replace(/\.tex$/, '.pdf');
          setPdfFile(pdf);
          setPdfUrl(api.outputUrl(projectId, pdf, Math.round(p.modified)));
        }
        setLoaded(true);
        api.index(projectId).then((idx) => (indexRef.current = idx));
        if (p.engines.some((e) => e.available)) compile();
      })
      .catch((e) => {
        toast(e.message, 'error');
        onClose();
      });
    return () => {
      alive = false;
    };
  }, [projectId]);

  // flush pending saves when leaving
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (saveTimers.current.size) {
        flushSaves();
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      flushSaves();
    };
  }, []);

  // ── live updates from disk ──────────────────────────────────────────────
  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry = 0;
    let closed = false;
    let treeTimer = 0;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?project=${projectId}`);
      ws.onopen = () => (retry = 0);
      ws.onmessage = async (ev) => {
        const msg = JSON.parse(ev.data) as { type: string; path: string };
        if (msg.type === 'change') {
          if (controller.has(msg.path) && !saveTimers.current.has(msg.path)) {
            const { content } = await api.readFile(projectId, msg.path).catch(() => ({ content: null as string | null }));
            if (content !== null) {
              controller.setContent(msg.path, content);
              if (msg.path === activeRef.current) setOutline(computeOutline(content));
            }
          }
          refreshIndex();
          if (settingsRef.current?.autoCompile && /\.(tex|bib|sty|cls|png|jpe?g|pdf)$/i.test(msg.path)) scheduleCompile();
        } else {
          clearTimeout(treeTimer);
          treeTimer = window.setTimeout(refreshTree, 200);
        }
      };
      ws.onclose = () => {
        if (closed) return;
        setTimeout(connect, Math.min(10000, 500 * 2 ** retry++));
      };
    };
    connect();
    return () => {
      closed = true;
      ws?.close();
    };
  }, [projectId]);

  // ── keyboard shortcuts outside the editor ───────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === 's') {
        e.preventDefault();
        saveAll(true);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        saveAll(true);
      } else if (e.key === '\\') {
        e.preventDefault();
        setSidebar((s) => !s);
      } else if (e.shiftKey && (e.key === 'E' || e.key === 'e')) {
        e.preventDefault();
        setMode((m) => (m === 'source' ? 'visual' : 'source'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ── splitter drag ───────────────────────────────────────────────────────
  const startDrag = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    setDragging(true);
    const rect = panesRef.current!.getBoundingClientRect();
    const move = (ev: PointerEvent) => setSplit(Math.max(0.2, Math.min(0.8, (ev.clientX - rect.left) / rect.width)));
    const up = () => {
      setDragging(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ── paste / drop images into the editor ────────────────────────────────
  // Der Editor fängt Strg+V bzw. abgelegte Bilder ab (editor/images.ts) und ruft
  // dies auf: Bilder in den Bilder-Ordner hochladen, dann Snippet einfügen.
  async function insertImages(path: string, files: File[], ticket: number) {
    const mainSetting = settingsRef.current?.mainFile ?? path;
    const readText = async (p: string) => controller.getContent(p) ?? (await api.readFile(projectId, p).then((r) => r.content).catch(() => null));
    const figures: FigureItem[] = [];
    const saved: string[] = [];
    const converted: string[] = [];
    try {
      const current = (await readText(path)) ?? '';
      // Eigenständige Dokumente (mit \documentclass) sind ihr eigenes Hauptdokument.
      const main = /\\documentclass/.test(current) ? path : mainSetting;
      const mainSource = main === path ? current : ((await readText(main)) ?? '');
      const tree = await api.tree(projectId);
      const allFiles = flatten(tree);
      const target = imageTarget(main, mainSource, allFiles, dirs(tree));
      const taken = new Set(allFiles.map((f) => f.toLowerCase()));
      const labels = new Set(indexRef.current?.labels.map((l) => l.label) ?? []);
      const now = new Date();
      for (const file of files) {
        try {
          const img = await prepareImage(file);
          const base = imageBaseName(file, now);
          let dest = uniquePath(target.dir, base, img.ext, taken);
          for (let attempt = 0; ; attempt++) {
            try {
              await api.upload(projectId, dest, img.blob, { exclusive: true });
              break;
            } catch (e) {
              if ((e as { status?: number }).status !== 409 || attempt > 20) throw e;
              taken.add(dest.toLowerCase());
              dest = uniquePath(target.dir, base, img.ext, taken);
            }
          }
          taken.add(dest.toLowerCase());
          saved.push(dest);
          if (img.convertedFrom) converted.push(img.convertedFrom.toUpperCase());
          figures.push({ path: includePath(dest, target), label: uniqueLabel(dest.split('/').pop()!.replace(/\.[^.]+$/, ''), labels) });
        } catch (e) {
          toast(`„${file.name || 'Bild'}“ konnte nicht eingefügt werden: ${(e as Error).message}`, 'error');
        }
      }
      if (saved.length) {
        const fresh = await api.tree(projectId).catch(() => null);
        if (fresh) {
          setTree(fresh);
          controller.setFiles(flatten(fresh)); // damit der visuelle Modus das Bild sofort findet
        }
      }
      if (!controller.insertImages(path, ticket, figures)) {
        if (saved.length) toast(`Bild gespeichert unter „${saved[0]}“ – Snippet nicht eingefügt, weil die Datei gewechselt wurde.`, 'info', 6000);
        return;
      }
      if (!saved.length) return;
      const where = saved.length === 1 ? `„${saved[0]}“` : `${saved.length} Bilder in „${target.dir || 'Projektordner'}“`;
      const conv = converted.length ? ` (${[...new Set(converted)].join(', ')} in PNG umgewandelt)` : '';
      toast(`${saved.length === 1 ? 'Bild gespeichert als ' : ''}${where}${saved.length === 1 ? '' : ' gespeichert'}${conv}`, 'success');
      if (!(await graphicxLoaded(main, mainSource, allFiles, readText))) {
        toast(`Hinweis: Das Paket „graphicx“ wird in „${main}“ nicht geladen. Ergänze \\usepackage{graphicx} in der Präambel, damit das Bild im PDF erscheint.`, 'info', 9000);
      }
    } catch (e) {
      controller.insertImages(path, ticket, []); // gemerkte Position freigeben
      toast(`Bild konnte nicht eingefügt werden: ${(e as Error).message}`, 'error');
    }
  }

  // Alles, was der Editor nicht selbst übernommen hat, landet wie bisher im Projektordner.
  const onEditorDrop = (e: React.DragEvent) => {
    setDropActive(false);
    const handled = handledDrops.has(e.nativeEvent);
    const rest = Array.from(e.dataTransfer.files).filter((f) => !handled || !isImageFile(f));
    if (!rest.length) return;
    e.preventDefault();
    upload('', rest);
  };

  // ── derived UI state ───────────────────────────────────────────────────
  const errors = result?.errors.length ?? 0;
  const warnings = result?.warnings.length ?? 0;
  const saving = savingCount > 0 || dirty.size > 0;
  const currentOutline = useMemo(() => {
    let idx = -1;
    outline.forEach((o, i) => {
      if (o.line <= cursorLine) idx = i;
    });
    return idx;
  }, [outline, cursorLine]);
  const noEngine = engines.length > 0 && !engines.some((e) => e.available);

  const statusText = compiling
    ? 'Kompiliere …'
    : saving
      ? 'Speichere …'
      : result
        ? result.status === 'success'
          ? `Kompiliert in ${((result.durationMs ?? 0) / 1000).toFixed(1)} s`
          : result.status === 'partial'
            ? 'Kompiliert mit Fehlern'
            : result.status === 'cancelled'
              ? 'Abgebrochen'
              : 'Kompilierung fehlgeschlagen'
        : 'Alle Änderungen gespeichert';
  const dotClass = compiling || saving ? 'pending' : result && result.status !== 'success' && result.status !== 'cancelled' ? 'err' : '';

  const showEditor = layout !== 'pdf';
  const showPdf = layout !== 'editor';

  const logPanel = logOpen && result && <LogPanel result={result} onClose={() => setLogOpen(false)} onJump={jumpToEntry} />;

  return (
    <div className="workspace">
      <header className="topbar">
        <div className="left">
          <button className="icon-btn" onClick={onClose} title="Zur Projektübersicht">
            <ChevronLeft size={18} />
          </button>
          <button className={`icon-btn ${sidebar ? 'active' : ''}`} onClick={() => setSidebar(!sidebar)} title={`Seitenleiste (${modKey}\\)`}>
            <PanelLeft size={16} />
          </button>
          <div className="project-title">
            <b>{name || ' '}</b>
            <span>
              <span className={`dot ${dotClass}`} />
              {statusText}
            </span>
          </div>
        </div>
        <div className="center">
          <Segmented
            value={layout}
            onChange={setLayout}
            options={[
              { value: 'editor', label: 'Editor', icon: <Code2 size={14} /> },
              { value: 'split', label: 'Geteilt', icon: <Columns2 size={14} /> },
              { value: 'pdf', label: 'PDF', icon: <FileText size={14} /> },
            ]}
          />
        </div>
        <div className="right">
          <GitPill git={git} onClick={(e) => setGitAnchor(gitAnchor ? null : e.currentTarget)} />
          {result && (
            <button className={`issue-pill ${!errors && !warnings ? 'ok' : ''}`} onClick={() => setLogOpen(!logOpen)} title="Protokoll anzeigen">
              {!errors && !warnings ? (
                <>
                  <CheckCircle2 size={13} /> OK
                </>
              ) : (
                <>
                  {errors > 0 && (
                    <span className="e">
                      <AlertCircle size={13} />
                      {errors}
                    </span>
                  )}
                  {warnings > 0 && (
                    <span className="w">
                      <AlertTriangle size={13} />
                      {warnings}
                    </span>
                  )}
                </>
              )}
            </button>
          )}
          <div className="compile-group">
            {compiling ? (
              <button className="btn primary" onClick={cancelCompile} title="Abbrechen">
                <div className="spinner" style={{ width: 12, height: 12 }} /> Kompiliere
              </button>
            ) : (
              <button className="btn primary" onClick={() => saveAll(true)} title={`Kompilieren (${modKey}S / ${modKey}↵)`} disabled={noEngine}>
                <Play size={13} fill="currentColor" /> Kompilieren
              </button>
            )}
            <button className="btn primary" onClick={(e) => setCompileMenu(e.currentTarget)}>
              <ChevronDown size={14} />
            </button>
          </div>
          <button className="icon-btn" onClick={(e) => setSettingsAnchor(e.currentTarget)} title="Einstellungen">
            <Settings2 size={16} />
          </button>
        </div>
      </header>

      {compileMenu && (
        <Popover anchor={compileMenu} onClose={() => setCompileMenu(null)} align="end">
          <div className="settings-body" style={{ width: 260, gap: 10 }}>
            <div className="settings-row">
              <span>
                Automatisch kompilieren
                <small>Nach jeder Änderung neu rendern</small>
              </span>
              <button className={`switch ${settings?.autoCompile ? 'on' : ''}`} onClick={() => settings && updateSettings({ autoCompile: !settings.autoCompile })} />
            </div>
          </div>
          <div className="menu-sep" />
          <Menu
            onClose={() => setCompileMenu(null)}
            items={[
              { label: 'Jetzt kompilieren', icon: <Play size={14} />, onClick: () => saveAll(true), kbd: `${modKey}S` },
              { label: 'Kompilierung abbrechen', icon: <Square size={13} />, onClick: cancelCompile, disabled: !compiling },
              { label: 'Protokoll anzeigen', icon: <AlertCircle size={14} />, onClick: () => setLogOpen(true), disabled: !result },
            ]}
          />
        </Popover>
      )}

      {gitAnchor && (
        <Popover anchor={gitAnchor} onClose={() => setGitAnchor(null)} align="end">
          <div className="settings-body git-body">
            <GitPanel git={git} autoFocus />
          </div>
        </Popover>
      )}

      {settingsAnchor && settings && (
        <Popover anchor={settingsAnchor} onClose={() => setSettingsAnchor(null)} align="end">
          <div className="settings-body">
            <div className="field">
              <label>Compiler</label>
              <select className="select" value={settings.engine} onChange={(e) => updateSettings({ engine: e.target.value })}>
                {engines.map((en) => (
                  <option key={en.id} value={en.id} disabled={!en.available}>
                    {en.label}
                    {en.available ? '' : ' (nicht installiert)'}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Hauptdatei</label>
              <select className="select" value={settings.mainFile} onChange={(e) => updateSettings({ mainFile: e.target.value })}>
                {files
                  .filter((f) => f.endsWith('.tex'))
                  .map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
              </select>
            </div>
            <div className="field">
              <label>Erscheinungsbild</label>
              <Segmented
                size="sm"
                value={theme}
                onChange={setTheme}
                options={[
                  { value: 'light', label: 'Hell', icon: <Sun size={12} /> },
                  { value: 'system', label: 'System', icon: <Monitor size={12} /> },
                  { value: 'dark', label: 'Dunkel', icon: <Moon size={12} /> },
                ]}
              />
            </div>
            <div className="field">
              <label>Schriftgröße im Editor: {fontSize}px</label>
              <input type="range" min={11} max={20} step={0.5} value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))} />
            </div>
            <div className="settings-hint">
              {modKey}S kompilieren · {modKey}B/I fett/kursiv · {modKey}/ kommentieren · {modKey}. zur PDF-Stelle · Doppelklick im PDF springt zum Code · {modKey}⇧E Quelltext/Visuell
            </div>
          </div>
        </Popover>
      )}

      <div className="body">
        <aside className={`sidebar ${sidebar ? '' : 'collapsed'}`}>
          <div className="side-section grow">
            <div className="side-head">
              <span>Dateien</span>
              <div className="tools">
                <button className="icon-btn sm" title="Neue Datei" onClick={() => newFile('')}>
                  <FilePlus size={14} />
                </button>
                <button className="icon-btn sm" title="Neuer Ordner" onClick={() => newFolder('')}>
                  <FolderPlus size={14} />
                </button>
                <label className="icon-btn sm" title="Dateien hochladen">
                  <Upload size={14} />
                  <input type="file" multiple hidden onChange={(e) => e.target.files && upload('', e.target.files)} />
                </label>
              </div>
            </div>
            <div className="side-scroll">
              <FileTree
                tree={tree}
                active={active}
                mainFile={settings?.mainFile ?? ''}
                projectId={projectId}
                onOpen={(p) => openFile(p)}
                onRename={renamePath}
                onDelete={deletePath}
                onSetMain={(p) => updateSettings({ mainFile: p })}
                onNewFile={newFile}
                onNewFolder={newFolder}
                onUpload={upload}
                onMove={(from, dir) => renamePath(from, dir ? `${dir}/${from.split('/').pop()}` : from.split('/').pop()!)}
              />
            </div>
          </div>
          <div className="side-divider" />
          <div className="side-section" style={{ maxHeight: '45%' }}>
            <div className="side-head">
              <span>Gliederung</span>
            </div>
            <div className="side-scroll">
              {outline.length === 0 && <div className="outline-empty">Keine Abschnitte in dieser Datei</div>}
              {outline.map((o, i) => (
                <div key={i} className={`outline-row l${o.level} ${i === currentOutline ? 'current' : ''}`} style={{ paddingLeft: 8 + Math.max(0, o.level - 1) * 12 }} onClick={() => controller.gotoLine(o.line)}>
                  {o.level > 2 && <span className="lvl" />}
                  <span>{o.title}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="side-divider" />
          <div className="side-section git-side">
            <div className="side-head clickable" onClick={() => setGitOpen(!gitOpen)}>
              <span>
                {gitOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />} GitHub
              </span>
            </div>
            {gitOpen && (
              <div className="side-scroll">
                <GitPanel git={git} />
              </div>
            )}
          </div>
        </aside>

        <div className="panes" ref={panesRef}>
          <section className={`pane editor-pane ${showEditor ? '' : 'hidden'}`} style={{ width: layout === 'split' ? `${split * 100}%` : undefined, flex: layout === 'editor' ? 1 : undefined }}>
            <div className="tabs">
              {openFiles.map((f) => (
                <div key={f} className={`tab ${f === active ? 'on' : ''}`} onClick={() => openFile(f)} onAuxClick={(e) => e.button === 1 && closeTab(f)} title={f}>
                  {fileIcon(f, 13)}
                  <span>{f.split('/').pop()}</span>
                  {dirty.has(f) ? (
                    <span className="x" onClick={(e) => (e.stopPropagation(), closeTab(f))}>
                      <span className="modified" />
                    </span>
                  ) : (
                    <span className="x" onClick={(e) => (e.stopPropagation(), closeTab(f))}>
                      <X size={11} />
                    </span>
                  )}
                </div>
              ))}
            </div>
            {active && !isBinary && <FormatBar controller={controller} heading={heading} mode={mode} setMode={(m) => (setMode(m), force((x) => x + 1))} isTex={isTex} />}
            <div
              className="editor-host"
              ref={hostRef}
              style={{ display: active && !isBinary ? undefined : 'none' }}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes('Files')) {
                  e.preventDefault();
                  setDropActive(true);
                }
              }}
              onDragLeave={() => setDropActive(false)}
              onDrop={onEditorDrop}
            >
              {dropActive && <div className="drop-overlay">Bilder hier ablegen, um sie einzufügen</div>}
            </div>
            {active && isBinary && (
              <div className="binary-view grid-bg">
                {/\.pdf$/i.test(active) ? (
                  <embed src={api.rawUrl(projectId, active)} type="application/pdf" style={{ width: '100%', height: '100%', borderRadius: 8 }} />
                ) : /\.(png|jpe?g|gif|webp|svg)$/i.test(active) ? (
                  <img src={api.rawUrl(projectId, active)} alt={active} />
                ) : (
                  <div className="empty-state">
                    <h3>Vorschau nicht verfügbar</h3>
                  </div>
                )}
              </div>
            )}
            {!active && loaded && (
              <div className="empty-state">
                <FileText size={34} />
                <h3>Keine Datei geöffnet</h3>
                <p>Wähle links eine Datei aus oder lege eine neue an.</p>
              </div>
            )}
            {!showPdf && logPanel}
          </section>

          {layout === 'split' && (
            <div className={`splitter ${dragging ? 'dragging' : ''}`} onPointerDown={startDrag} onDoubleClick={() => setSplit(0.5)}>
              <div className="sync-buttons">
                <button title={`Zur Stelle im PDF (${modKey}.)`} onClick={syncForward}>
                  <ArrowRight size={13} />
                </button>
                <button title="Doppelklick ins PDF springt zum Code" onClick={() => toast('Doppelklicke auf eine Stelle im PDF, um zum Quelltext zu springen.', 'info')}>
                  <ArrowLeft size={13} />
                </button>
              </div>
            </div>
          )}

          <section className={`pane pdf-pane grid-bg ${showPdf ? '' : 'hidden'}`} style={{ pointerEvents: dragging ? 'none' : undefined }}>
            <PdfViewer
              ref={pdfRef}
              url={pdfUrl}
              downloadUrl={pdfFile ? api.outputUrl(projectId, pdfFile, null, true) : null}
              compiling={compiling}
              persistKey={projectId}
              emptyTitle={noEngine ? 'Kein LaTeX-Compiler installiert' : 'Noch kein PDF'}
              emptyText={
                noEngine
                  ? 'Installiere TeX Live oder Tectonic (siehe Projektübersicht) und starte den Server neu. Bis dahin kannst du im visuellen Modus schreiben.'
                  : `Klicke auf „Kompilieren“ oder drücke ${modKey}S.`
              }
              onInverse={syncInverse}
            />
            {showPdf && logPanel}
          </section>
        </div>
      </div>
    </div>
  );
}
