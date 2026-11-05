import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, CloudAlert, CloudCheck, ExternalLink, GitBranch, Link2, RefreshCw } from 'lucide-react';
import { api, type GitPrefer, type GitResult, type GitStatus } from '../api';
import { relativeTime, useDialogs, usePersistentState } from '../ui';

const PULL_EVERY = 20_000; // look for new commits on GitHub
const SYNC_EVERY = 60_000; // commit & push local changes

type Status = GitStatus & { unsupported?: boolean };
export type GitSyncState = ReturnType<typeof useGitSync>;

/**
 * GitHub link for the open project: pulls on open, when new commits appear and on demand;
 * commits & pushes on demand and once a minute.
 */
export function useGitSync(projectId: string, beforeSync: () => Promise<void>, onPulled: (files: string[]) => void) {
  const { toast } = useDialogs();
  const [status, setStatus] = useState<Status | null>(null);
  const [auto, setAuto] = usePersistentState(`folio.gitAuto.${projectId}`, true);
  const [busy, setBusy] = useState<null | 'pull' | 'sync' | 'link'>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [lastSync, setLastSync] = useState<number | null>(null);

  const busyRef = useRef(false);
  const onPulledRef = useRef(onPulled);
  const beforeSyncRef = useRef(beforeSync);
  onPulledRef.current = onPulled;
  beforeSyncRef.current = beforeSync;

  const linked = !!status?.repo && !!status.remote;

  const run = useCallback(
    async (kind: 'pull' | 'sync' | 'link', fn: () => Promise<GitResult>, manual: boolean) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(kind);
      try {
        await beforeSyncRef.current();
        const r = await fn();
        setStatus(r.status);
        setError(null);
        setConflict(!!r.conflict);
        if (r.pulled?.length) onPulledRef.current(r.pulled);
        if (r.conflict) {
          if (manual) toast('Konflikt mit Änderungen auf GitHub – bitte auswählen, welche Version gelten soll', 'error');
        } else {
          setLastSync(Date.now());
          if (manual) {
            const parts = [r.pulled?.length ? `${r.pulled.length} Datei${r.pulled.length === 1 ? '' : 'en'} geholt` : '', r.pushed ? 'hochgeladen' : ''].filter(Boolean);
            toast(kind === 'link' ? 'Mit GitHub verknüpft' : parts.length ? `GitHub: ${parts.join(', ')}` : 'Alles aktuell', 'success');
          }
        }
      } catch (e) {
        const msg = (e as Error).message;
        // don't nag every minute with the same message
        setError((prev) => {
          if (manual || prev !== msg) toast(`GitHub: ${msg}`, 'error');
          return msg;
        });
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
    },
    [toast],
  );

  const pull = useCallback((manual = false, prefer?: GitPrefer) => run('pull', () => api.gitPull(projectId, prefer), manual), [run, projectId]);
  const sync = useCallback((manual = false, msg?: string, prefer?: GitPrefer) => run('sync', () => api.gitSync(projectId, msg, prefer), manual), [run, projectId]);
  const link = useCallback((url: string) => run('link', () => api.gitLink(projectId, url), true), [run, projectId]);

  const refresh = useCallback(
    () =>
      api
        .gitStatus(projectId)
        .then((s) => (setStatus(s), s))
        // an older server without the git endpoint
        .catch(() => (setStatus({ available: false, repo: false, unsupported: true }), null)),
    [projectId],
  );

  // detect the repo when the project opens and pull right away
  useEffect(() => {
    let alive = true;
    setStatus(null);
    setError(null);
    setConflict(false);
    refresh().then((s) => {
      if (alive && s?.repo && s.remote && auto) pull();
    });
    return () => {
      alive = false;
    };
  }, [projectId]);

  // background loop
  useEffect(() => {
    if (!linked || !auto || conflict) return;
    const p = window.setInterval(() => pull(), PULL_EVERY);
    const s = window.setInterval(() => sync(), SYNC_EVERY);
    return () => {
      clearInterval(p);
      clearInterval(s);
    };
  }, [linked, auto, conflict, pull, sync]);

  return { status, linked, auto, setAuto, busy, error, conflict, lastSync, pull, sync, link, refresh };
}

const repoName = (s: Status) => (s.web ? s.web.replace(/^https:\/\/[^/]+\//, '') : s.url);

/** Compact status button for the top bar. */
export function GitPill({ git, onClick }: { git: GitSyncState; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void }) {
  const { status, linked, busy, error, conflict } = git;
  if (!status) return null;
  const ahead = status.ahead ?? 0;
  const behind = status.behind ?? 0;
  const dirty = status.dirty ?? 0;
  const state = !linked ? 'off' : conflict || error ? 'err' : busy ? 'busy' : 'ok';
  return (
    <button
      className={`git-pill ${state}`}
      onClick={onClick}
      title={!linked ? 'GitHub-Optionen' : conflict ? 'Konflikt mit GitHub' : error ? `GitHub: ${error}` : `GitHub: ${repoName(status)} (${status.branch})`}
    >
      {state === 'busy' ? <RefreshCw size={13} className="spin" /> : state === 'err' ? <CloudAlert size={14} /> : state === 'off' ? <GitBranch size={13} /> : <CloudCheck size={14} />}
      <span className="label">{linked ? status.branch : 'GitHub'}</span>
      {linked && dirty + ahead > 0 && <span className="badge" title="Lokale Änderungen, noch nicht hochgeladen">↑{ahead || '•'}</span>}
      {linked && behind > 0 && <span className="badge" title="Neue Commits auf GitHub">↓{behind}</span>}
    </button>
  );
}

/** All GitHub options: link, status, pull, commit & push, auto sync. */
export function GitPanel({ git, autoFocus }: { git: GitSyncState; autoFocus?: boolean }) {
  const { status, busy, error, conflict, lastSync, auto, setAuto, pull, sync, link } = git;
  const [message, setMessage] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [, tick] = useState(0);

  // keep "vor x Min." fresh
  useEffect(() => {
    const t = window.setInterval(() => tick((x) => x + 1), 15_000);
    return () => clearInterval(t);
  }, []);

  if (!status) return <div className="git-text">Prüfe Git …</div>;

  if (status.unsupported)
    return (
      <div className="git-panel">
        <div className="git-alert">
          <b>Server neu starten</b>
          <span>Der laufende Folio-Server ist noch eine ältere Version ohne GitHub-Unterstützung. Starte ihn neu (z. B. „folio restart“).</span>
        </div>
        <button className="btn" onClick={() => git.refresh()}>
          <RefreshCw size={13} /> Erneut prüfen
        </button>
      </div>
    );

  if (!status.available)
    return (
      <div className="git-panel">
        <div className="git-alert">
          <b>Git ist nicht installiert</b>
          <span>Installiere Git (z. B. „winget install Git.Git“) und starte Folio neu.</span>
        </div>
      </div>
    );

  if (!status.repo || !status.remote) {
    const doLink = () => linkUrl.trim() && link(linkUrl);
    return (
      <div className="git-panel">
        <p className="git-text">
          {status.repo
            ? 'Dieser Ordner ist ein Git-Repository, aber ohne Remote. Gib die URL deines GitHub-Repositorys an.'
            : 'Nicht mit GitHub verknüpft. Lege auf GitHub ein (leeres) Repository an und füge hier die URL ein – danach wird automatisch synchronisiert.'}
        </p>
        <input className="input" autoFocus={autoFocus} placeholder="https://github.com/name/repo" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && doLink()} />
        <button className="btn primary" disabled={!linkUrl.trim() || !!busy} onClick={doLink}>
          {busy === 'link' ? <RefreshCw size={13} className="spin" /> : <Link2 size={13} />} Mit GitHub verknüpfen
        </button>
        {error && <div className="git-alert">{error}</div>}
      </div>
    );
  }

  const ahead = status.ahead ?? 0;
  const behind = status.behind ?? 0;
  const dirty = status.dirty ?? 0;
  const commit = () => sync(true, message.trim() || undefined).then(() => setMessage(''));

  return (
    <div className="git-panel">
      <div className="git-head">
        <GitBranch size={14} />
        <div className="git-repo">
          {status.web ? (
            <a href={status.web} target="_blank" rel="noreferrer" title="Auf GitHub öffnen">
              {repoName(status)} <ExternalLink size={11} />
            </a>
          ) : (
            <b>{repoName(status)}</b>
          )}
          <small>
            Branch {status.branch ?? '–'}
            {lastSync ? ` · synchronisiert ${relativeTime(lastSync)}` : ''}
          </small>
        </div>
      </div>

      <div className="git-stats">
        <span className={dirty ? 'on' : ''}>{dirty ? `${dirty} geänderte Datei${dirty === 1 ? '' : 'en'}` : 'Keine lokalen Änderungen'}</span>
        {ahead > 0 && <span className="on">{ahead} Commit{ahead === 1 ? '' : 's'} nicht hochgeladen</span>}
        {behind > 0 && <span className="on">{behind} neue{behind === 1 ? 'r' : ''} Commit{behind === 1 ? '' : 's'} auf GitHub</span>}
        {status.lastCommit && (
          <span title={status.lastCommit.message}>
            Letzter Commit: {status.lastCommit.message.length > 40 ? status.lastCommit.message.slice(0, 40) + '…' : status.lastCommit.message} ({relativeTime(status.lastCommit.time)})
          </span>
        )}
      </div>

      {conflict && (
        <div className="git-alert">
          <b>Konflikt</b>
          <span>Dieselben Stellen wurden lokal und auf GitHub geändert. Welche Version soll gelten?</span>
          <div className="git-actions">
            <button className="btn" disabled={!!busy} onClick={() => sync(true, undefined, 'mine')}>
              Meine behalten
            </button>
            <button className="btn" disabled={!!busy} onClick={() => sync(true, undefined, 'remote')}>
              GitHub übernehmen
            </button>
          </div>
        </div>
      )}
      {error && !conflict && <div className="git-alert">{error}</div>}

      <input className="input" placeholder="Commit-Nachricht (optional)" value={message} onChange={(e) => setMessage(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && commit()} />
      <div className="git-actions">
        <button className="btn" disabled={!!busy} onClick={() => pull(true)} title="Neue Commits von GitHub holen">
          {busy === 'pull' ? <RefreshCw size={13} className="spin" /> : <ArrowDownToLine size={13} />} Pull
        </button>
        <button className="btn primary" disabled={!!busy} onClick={commit} title="Änderungen committen und zu GitHub hochladen">
          {busy === 'sync' ? <RefreshCw size={13} className="spin" /> : <ArrowUpFromLine size={13} />} Commit &amp; Push
        </button>
      </div>

      <div className="settings-row">
        <span>
          Automatisch synchronisieren
          <small>Holt neue Commits sofort, committet &amp; pusht jede Minute</small>
        </span>
        <button className={`switch ${auto ? 'on' : ''}`} onClick={() => setAuto(!auto)} />
      </div>
    </div>
  );
}
