import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, AlertCircle, Info } from 'lucide-react';

// ── Segmented control with sliding thumb ────────────────────────────────
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size,
}: {
  value: T;
  options: { value: T; label: ReactNode; icon?: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  size?: 'sm';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current?.querySelector<HTMLButtonElement>(`button[data-v="${value}"]`);
    if (el) setThumb({ left: el.offsetLeft, width: el.offsetWidth });
  }, [value, options.length]);
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      const el = ref.current?.querySelector<HTMLButtonElement>(`button[data-v="${value}"]`);
      if (el) setThumb({ left: el.offsetLeft, width: el.offsetWidth });
    });
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, [value]);
  return (
    <div className={`segmented ${size ?? ''}`} ref={ref}>
      {thumb && <div className="thumb" style={{ left: thumb.left, width: thumb.width }} />}
      {options.map((o) => (
        <button key={o.value} data-v={o.value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)} title={o.title}>
          {o.icon}
          {o.label && <span className="label">{o.label}</span>}
        </button>
      ))}
    </div>
  );
}

// ── Popover anchored to an element ──────────────────────────────────────
export function Popover({
  anchor,
  onClose,
  children,
  align = 'start',
  className,
}: {
  anchor: HTMLElement | DOMRect | null;
  onClose: () => void;
  children: ReactNode;
  align?: 'start' | 'end' | 'center';
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!anchor || !ref.current) return;
    const r = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : anchor;
    const w = ref.current.offsetWidth;
    const h = ref.current.offsetHeight;
    let left = align === 'end' ? r.right - w : align === 'center' ? r.left + r.width / 2 - w / 2 : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    setPos({ top, left });
  }, [anchor, align]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        if (anchor instanceof HTMLElement && anchor.contains(e.target as Node)) return;
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);
  if (!anchor) return null;
  return createPortal(
    <div ref={ref} className={`popover ${className ?? ''}`} style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden', top: 0, left: 0 }}>
      {children}
    </div>,
    document.body,
  );
}

export type MenuEntry =
  | { label: string; icon?: ReactNode; onClick: () => void; danger?: boolean; kbd?: string; disabled?: boolean }
  | 'sep'
  | { heading: string };

export function Menu({ items, onClose }: { items: MenuEntry[]; onClose: () => void }) {
  return (
    <div>
      {items.map((it, i) =>
        it === 'sep' ? (
          <div key={i} className="menu-sep" />
        ) : 'heading' in it ? (
          <div key={i} className="menu-label">
            {it.heading}
          </div>
        ) : (
          <button
            key={i}
            className={`menu-item ${it.danger ? 'danger' : ''}`}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onClick();
            }}
          >
            {it.icon}
            <span>{it.label}</span>
            {it.kbd && <span className="kbd">{it.kbd}</span>}
          </button>
        ),
      )}
    </div>
  );
}

// ── Dialog ──────────────────────────────────────────────────────────────
export function Dialog({ children, onClose, width }: { children: ReactNode; onClose: () => void; width?: number }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={width ? { width: `min(${width}px, calc(100vw - 32px))` } : undefined}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

type PromptState = {
  title: string;
  message?: string;
  value?: string;
  placeholder?: string;
  confirm: string;
  danger?: boolean;
  input: boolean;
  resolve: (v: string | null) => void;
};

const DialogCtx = createContext<{
  prompt: (o: { title: string; message?: string; value?: string; placeholder?: string; confirm?: string }) => Promise<string | null>;
  confirm: (o: { title: string; message?: string; confirm?: string; danger?: boolean }) => Promise<boolean>;
  toast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}>(null!);

export const useDialogs = () => useContext(DialogCtx);

export function DialogProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PromptState | null>(null);
  const [toasts, setToasts] = useState<{ id: number; msg: string; kind: string }[]>([]);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const prompt = useCallback(
    (o: { title: string; message?: string; value?: string; placeholder?: string; confirm?: string }) =>
      new Promise<string | null>((resolve) => {
        setValue(o.value ?? '');
        setState({ ...o, confirm: o.confirm ?? 'OK', input: true, resolve });
      }),
    [],
  );
  const confirm = useCallback(
    (o: { title: string; message?: string; confirm?: string; danger?: boolean }) =>
      new Promise<boolean>((resolve) => {
        setState({ ...o, confirm: o.confirm ?? 'OK', input: false, resolve: (v) => resolve(v !== null) });
      }),
    [],
  );
  const toast = useCallback((msg: string, kind: 'success' | 'error' | 'info' = 'info') => {
    const id = Math.random();
    setToasts((t) => [...t.slice(-3), { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3200);
  }, []);

  useEffect(() => {
    if (state?.input) {
      setTimeout(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        const dot = el.value.lastIndexOf('.');
        el.setSelectionRange(0, dot > 0 ? dot : el.value.length);
      }, 30);
    }
  }, [state]);

  const close = (v: string | null) => {
    state?.resolve(v);
    setState(null);
  };

  return (
    <DialogCtx.Provider value={{ prompt, confirm, toast }}>
      {children}
      {state && (
        <Dialog onClose={() => close(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (state.input && !value.trim()) return;
              close(state.input ? value.trim() : '');
            }}
          >
            <h2>{state.title}</h2>
            {state.message && <p className="sub">{state.message}</p>}
            {state.input && <input ref={inputRef} className="input" value={value} placeholder={state.placeholder} onChange={(e) => setValue(e.target.value)} style={{ marginTop: state.message ? 0 : 12 }} />}
            <div className="actions">
              <button type="button" className="btn" onClick={() => close(null)}>
                Abbrechen
              </button>
              <button type="submit" className={`btn ${state.danger ? 'danger' : 'primary'}`} autoFocus={!state.input}>
                {state.confirm}
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {createPortal(
        <div className="toasts">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.kind}`}>
              {t.kind === 'success' ? <CheckCircle2 size={16} /> : t.kind === 'error' ? <AlertCircle size={16} /> : <Info size={16} />}
              <span>{t.msg}</span>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </DialogCtx.Provider>
  );
}

// ── Theme ───────────────────────────────────────────────────────────────
export type ThemePref = 'system' | 'light' | 'dark';

export function useTheme(): [ThemePref, (t: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(() => (localStorage.getItem('folio.theme') as ThemePref) || 'system');
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = pref === 'dark' || (pref === 'system' && mq.matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    mq.addEventListener('change', apply);
    localStorage.setItem('folio.theme', pref);
    return () => mq.removeEventListener('change', apply);
  }, [pref]);
  return [pref, setPref];
}

export function usePersistentState<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {}
  }, [key, v]);
  return [v, setV];
}

export function relativeTime(ts: number) {
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return 'gerade eben';
  if (diff < 3600) return `vor ${Math.floor(diff / 60)} Min.`;
  if (diff < 86400) return `vor ${Math.floor(diff / 3600)} Std.`;
  if (diff < 86400 * 7) return `vor ${Math.floor(diff / 86400)} Tag${diff >= 86400 * 2 ? 'en' : ''}`;
  return new Date(ts).toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' });
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = isMac ? '⌘' : 'Strg+';
