import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Plus, MoreHorizontal, Folder, ChevronLeft, AlertTriangle, Moon, Sun, Monitor, Trash2, X, Search } from 'lucide-react';
import { api, type Info, type Project } from '../api';
import { Dialog, Menu, Popover, relativeTime, useDialogs, Segmented, type ThemePref } from '../ui';
import { renderPdfThumb } from '../pdf';

export function ProjectBrowser({ onOpen, theme, setTheme }: { onOpen: (id: string) => void; theme: ThemePref; setTheme: (t: ThemePref) => void }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showOpen, setShowOpen] = useState(false);
  const [query, setQuery] = useState('');
  const { toast } = useDialogs();

  const load = () =>
    api
      .projects()
      .then(setProjects)
      .catch((e) => toast(e.message, 'error'));

  useEffect(() => {
    load();
    api.info().then(setInfo).catch(() => {});
    document.title = 'Folio';
  }, []);

  const noEngine = info && !info.engines.some((e) => e.available);
  const filtered = (projects ?? []).filter((p) => p.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="home grid-bg">
      <div className="home-bar">
        <div className="brand">
          <div className="brand-mark">Tχ</div>
          <b>Folio</b>
        </div>
        <span style={{ color: 'var(--dim)', fontSize: 11 }}>LaTeX-Editor · lokal</span>
        <div className="spacer" />
        <Segmented
          size="sm"
          value={theme}
          onChange={setTheme}
          options={[
            { value: 'dark', label: '', icon: <Moon size={13} />, title: 'Dunkel' },
            { value: 'light', label: '', icon: <Sun size={13} />, title: 'Hell' },
            { value: 'system', label: '', icon: <Monitor size={13} />, title: 'System' },
          ]}
        />
      </div>
      <div className="home-inner">
        <header className="home-header">
          <div className="home-title">
            <h1>Projekte</h1>
            <p>Deine LaTeX-Projekte liegen als normale Ordner auf diesem Rechner.</p>
          </div>
          <div className="home-actions">
            <button className="btn lg" onClick={() => setShowOpen(true)}>
              <FolderOpen size={14} /> Ordner öffnen
            </button>
            <button className="btn lg primary" onClick={() => setShowNew(true)}>
              <Plus size={14} /> Neues Projekt
            </button>
          </div>
        </header>

        {noEngine && (
          <div className="empty-hint" style={{ marginBottom: 28 }}>
            <AlertTriangle size={18} />
            <div>
              <b>Kein LaTeX-Compiler gefunden.</b> Du kannst schon schreiben, zum Rendern wird aber TeX Live oder Tectonic benötigt:
              <br />
              <code>sudo pacman -S texlive-basic texlive-latex texlive-latexrecommended texlive-latexextra texlive-fontsrecommended texlive-langgerman texlive-binextra texlive-bibtexextra biber</code>
              <br />
              oder schlanker: <code>sudo pacman -S tectonic</code> – danach den Server neu starten.
            </div>
          </div>
        )}

        <div className="section-title">
          <span>
            Alle Projekte <span className="count">({projects?.length ?? 0})</span>
          </span>
          {(projects?.length ?? 0) > 6 && (
            <div style={{ position: 'relative', width: 220 }}>
              <Search size={13} style={{ position: 'absolute', left: 8, top: 7, color: 'var(--dim)' }} />
              <input className="input" placeholder="Suchen" value={query} onChange={(e) => setQuery(e.target.value)} style={{ height: 26, paddingLeft: 26, fontSize: 12 }} />
            </div>
          )}
        </div>
        <div className="project-grid">
          <button className="project-card new-card" onClick={() => setShowNew(true)}>
            <div className="plus">
              <Plus size={20} />
            </div>
            Neues Projekt
          </button>
          {filtered.map((p) => (
            <ProjectCard key={p.id} project={p} onOpen={() => onOpen(p.id)} onChanged={load} />
          ))}
        </div>
        {info && (
          <p className="workspace-path">Neue Projekte werden gespeichert in {info.workspace}</p>
        )}
      </div>
      {showNew && info && (
        <NewProjectDialog
          info={info}
          onClose={() => setShowNew(false)}
          onCreated={(p) => {
            setShowNew(false);
            onOpen(p.id);
          }}
        />
      )}
      {showOpen && (
        <OpenFolderDialog
          home={info?.home}
          onClose={() => setShowOpen(false)}
          onOpened={(p) => {
            setShowOpen(false);
            onOpen(p.id);
          }}
        />
      )}
    </div>
  );
}

function ProjectCard({ project, onOpen, onChanged }: { project: Project; onOpen: () => void; onChanged: () => void }) {
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const paperRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState(false);
  const { confirm, toast } = useDialogs();

  useEffect(() => {
    if (!project.hasPdf) return;
    let alive = true;
    renderPdfThumb(api.outputUrl(project.id, project.mainFile.replace(/\.tex$/, '.pdf').split('/').pop()!, Math.round(project.modified)), 240)
      .then((canvas) => {
        if (!alive || !paperRef.current) return;
        const c = document.createElement('canvas');
        c.width = canvas.width;
        c.height = canvas.height;
        c.getContext('2d')!.drawImage(canvas, 0, 0);
        paperRef.current.replaceChildren(c);
        setThumb(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [project.id, project.hasPdf, project.modified]);

  return (
    <div className="project-card" onClick={onOpen} role="button">
      <div className="project-thumb">
        <div className="paper" ref={paperRef} style={thumb ? { padding: 0 } : undefined}>
          <div className="l t" />
          {Array.from({ length: 12 }, (_, i) => (
            <div key={i} className="l" style={{ width: `${[100, 92, 97, 60, 100, 88, 95, 40, 100, 90, 96, 70][i]}%` }} />
          ))}
        </div>
      </div>
      <div className="project-meta">
        <div className="name">{project.name}</div>
        <div className="sub">
          {relativeTime(project.modified)} · {project.inWorkspace ? project.mainFile : project.path}
        </div>
      </div>
      <button
        className="icon-btn sm more"
        onClick={(e) => {
          e.stopPropagation();
          setMenu(e.currentTarget);
        }}
      >
        <MoreHorizontal size={15} />
      </button>
      {menu && (
        <Popover anchor={menu} onClose={() => setMenu(null)} align="end">
          <div onClick={(e) => e.stopPropagation()}>
            <Menu
              onClose={() => setMenu(null)}
              items={[
                { label: 'Öffnen', icon: <FolderOpen size={14} />, onClick: onOpen },
                'sep',
                project.inWorkspace
                  ? {
                      label: 'In den Papierkorb',
                      icon: <Trash2 size={14} />,
                      danger: true,
                      onClick: async () => {
                        if (
                          await confirm({
                            title: `„${project.name}“ in den Papierkorb verschieben?`,
                            message: 'Der Ordner wird nach projects/.trash verschoben und kann von dort wiederhergestellt werden.',
                            confirm: 'Verschieben',
                            danger: true,
                          })
                        ) {
                          await api.removeProject(project.id, true).catch((e) => toast(e.message, 'error'));
                          onChanged();
                        }
                      },
                    }
                  : {
                      label: 'Aus Liste entfernen',
                      icon: <X size={14} />,
                      onClick: async () => {
                        await api.removeProject(project.id, false);
                        onChanged();
                      },
                    },
              ]}
            />
          </div>
        </Popover>
      )}
    </div>
  );
}

function NewProjectDialog({ info, onClose, onCreated }: { info: Info; onClose: () => void; onCreated: (p: Project) => void }) {
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('article');
  const [busy, setBusy] = useState(false);
  const { toast } = useDialogs();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      onCreated(await api.createProject(name.trim(), template));
    } catch (err) {
      toast((err as Error).message, 'error');
      setBusy(false);
    }
  };
  return (
    <Dialog onClose={onClose} width={520}>
      <form onSubmit={submit}>
        <h2>Neues Projekt</h2>
        <p className="sub">Das Projekt wird als normaler Ordner auf deinem Rechner angelegt.</p>
        <div className="field">
          <label>Name</label>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. Bachelorarbeit" />
        </div>
        <div className="field" style={{ marginTop: 16 }}>
          <label>Vorlage</label>
          <div className="template-grid">
            {info.templates.map((t) => (
              <button type="button" key={t.id} className={`template-option ${template === t.id ? 'on' : ''}`} onClick={() => setTemplate(t.id)}>
                <b>{t.name}</b>
                <span>{t.description}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button type="submit" className="btn primary" disabled={!name.trim() || busy}>
            Erstellen
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function OpenFolderDialog({ home, onClose, onOpened }: { home?: string; onClose: () => void; onOpened: (p: Project) => void }) {
  const [path, setPath] = useState(home ?? '');
  const [listing, setListing] = useState<{ path: string; parent: string | null; dirs: string[]; texCount: number } | null>(null);
  const { toast } = useDialogs();

  const browse = (p?: string) =>
    api
      .browse(p)
      .then((l) => {
        setListing(l);
        setPath(l.path);
      })
      .catch((e) => toast(e.message, 'error'));

  useEffect(() => {
    browse(home);
  }, []);

  const open = async (p: string) => {
    try {
      onOpened(await api.openFolder(p));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <Dialog onClose={onClose} width={560}>
      <h2>Ordner öffnen</h2>
      <p className="sub">Wähle einen Ordner mit LaTeX-Dateien. Die Dateien bleiben an Ort und Stelle und werden direkt bearbeitet.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          browse(path);
        }}
        style={{ display: 'flex', gap: 6 }}
      >
        <button type="button" className="icon-btn" disabled={!listing?.parent} onClick={() => listing?.parent && browse(listing.parent)} style={{ height: 32, width: 32 }}>
          <ChevronLeft size={16} />
        </button>
        <input className="input" value={path} onChange={(e) => setPath(e.target.value)} style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }} />
      </form>
      <div className="browser-list">
        {listing?.dirs.length === 0 && <div className="outline-empty">Keine Unterordner</div>}
        {listing?.dirs.map((d) => (
          <button key={d} className="browser-row" onDoubleClick={() => open(`${listing.path}/${d}`)} onClick={() => browse(`${listing.path}/${d}`)}>
            <Folder size={15} fill="currentColor" fillOpacity={0.18} />
            {d}
          </button>
        ))}
      </div>
      <div className="actions" style={{ alignItems: 'center' }}>
        <span style={{ marginRight: 'auto', color: 'var(--muted)', fontSize: 12 }}>
          {listing ? (listing.texCount ? `${listing.texCount} .tex-Datei${listing.texCount > 1 ? 'en' : ''} in diesem Ordner` : 'Keine .tex-Dateien in diesem Ordner') : ''}
        </span>
        <button className="btn" onClick={onClose}>
          Abbrechen
        </button>
        <button className="btn primary" onClick={() => listing && open(listing.path)} disabled={!listing}>
          Diesen Ordner öffnen
        </button>
      </div>
    </Dialog>
  );
}
