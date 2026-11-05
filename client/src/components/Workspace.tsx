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
} from 'lucide-react';
import { api, type CompileResult, type Engine, type LogEntry, type ProjectIndex, type Settings, type TreeNode } from '../api';
import { EditorController, type EditorMode } from '../editor/controller';
import { currentHeading } from '../editor/format';
import { FileTree, fileIcon } from './FileTree';
import { FormatBar } from './FormatBar';
import { PdfViewer, type PdfViewerHandle } from './PdfViewer';
import { LogPanel } from './LogPanel';
import { Menu, Popover, Segmented, usePersistentState, useDialogs, modKey, type ThemePref } from '../ui';
import { flatten } from '../tree';

type Layout = 'editor' | 'split' | 'pdf';
type OutlineItem = { level: number; title: string; line: number };

const BINARY = /\.(png|jpe?g|gif|webp|svg|pdf|eps|ico|bmp|zip|gz)$/i;
const LEVELS: Record<string, number> = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5 };

function computeOutline(text: string): OutlineItem[] {
  const out: OutlineItem[] = [];
  const lines = text.split('\n');
  lines.forEach((l, i) => {
    const m = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\{(.*)\}/.exec(l);
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

  // ── drop images onto editor ─────────────────────────────────────────────
  const onEditorDrop = async (e: React.DragEvent) => {
    setDropActive(false);
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    const paths = await upload('', e.dataTransfer.files);
    const images = paths.filter((p) => /\.(png|jpe?g|pdf|eps)$/i.test(p));
    if (images.length && isTex) {
      const v = controller.view;
      const pos = v.posAtCoords({ x: e.clientX, y: e.clientY }) ?? v.state.selection.main.head;
      const insert = images.map((p) => `\\begin{figure}[h]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{${p}}\n  \\caption{${p.replace(/\.[^.]+$/, '')}}\n\\end{figure}\n`).join('\n');
      const line = v.state.doc.lineAt(pos);
      v.dispatch({ changes: { from: line.to, insert: '\n' + insert } });
    }
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
