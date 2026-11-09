import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ZoomIn, ZoomOut, Download, ChevronUp, ChevronDown, Moon, FileText, Maximize2, CornerUpLeft } from 'lucide-react';
import { pdfjs } from '../pdf';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { Menu, Popover } from '../ui';

export type SyncHighlight = { page: number; rects: { x: number; y: number; w: number; h: number }[]; key: number };

export interface PdfViewerHandle {
  showHighlight: (h: SyncHighlight) => void;
}

interface Props {
  url: string | null;
  downloadUrl: string | null;
  compiling: boolean;
  emptyTitle: string;
  emptyText: string;
  onInverse: (page: number, x: number, y: number) => void;
  persistKey: string;
}

type PageSlot = {
  el: HTMLDivElement;
  page: PDFPageProxy | null;
  width: number; // in bp
  height: number;
  renderedScale: number;
  rendering: boolean;
  textLayer: HTMLDivElement | null;
  linkLayer: HTMLDivElement | null;
  linksDoc: PDFDocumentProxy | null;
};

type ViewPos = { page: number; y: number; x: number };

const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

/** Internal link targets (named or explicit destinations), keyed by the link element. */
const linkDests = new WeakMap<Element, unknown>();

/** Resolve a PDF destination to a page index and a point in PDF user space. */
async function resolveDest(doc: PDFDocumentProxy, dest: unknown) {
  const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
  if (!Array.isArray(explicit)) return null;
  const [ref, mode, ...args] = explicit;
  let pageIdx: number;
  if (ref && typeof ref === 'object') pageIdx = await doc.getPageIndex(ref);
  else if (Number.isInteger(ref)) pageIdx = ref;
  else return null;
  let x: unknown = null;
  let y: unknown = null;
  switch (mode?.name) {
    case 'XYZ':
      [x, y] = args;
      break;
    case 'FitH':
    case 'FitBH':
      y = args[0];
      break;
    case 'FitR':
      x = args[0];
      y = args[3];
      break;
  }
  return { pageIdx, x: typeof x === 'number' ? x : null, y: typeof y === 'number' ? y : null };
}

/** Bounding box (top-left origin, bp) of the first text line below `top`, e.g. the heading or bib entry a link points to. */
async function lineBelow(page: PDFPageProxy, top: number) {
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const items: { x: number; base: number; w: number; h: number }[] = [];
  for (const it of tc.items) {
    if (!('str' in it) || !it.str.trim()) continue;
    const [x, base] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
    items.push({ x, base, w: it.width, h: it.height });
  }
  let first = Infinity;
  for (const i of items) if (i.base > top + 1 && i.base < first) first = i.base;
  if (first - top > 100) return null;
  const line = items.filter((i) => Math.abs(i.base - first) < 2);
  if (!line.length) return null;
  const x0 = Math.min(...line.map((i) => i.x));
  const x1 = Math.max(...line.map((i) => i.x + i.w));
  const h = Math.max(...line.map((i) => i.h));
  return { x: x0, y: first - h * 0.8, w: x1 - x0, h: h * 1.05 };
}

export const PdfViewer = forwardRef<PdfViewerHandle, Props>(function PdfViewer(
  { url, downloadUrl, compiling, emptyTitle, emptyText, onInverse, persistKey },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const slotsRef = useRef<PageSlot[]>([]);
  const scaleRef = useRef(1);
  const [zoomMode, setZoomMode] = useState<'fit' | 'page' | number>(() => {
    const raw = localStorage.getItem(`folio.zoom.${persistKey}`);
    return raw ? (raw === 'fit' || raw === 'page' ? raw : Number(raw)) : 'fit';
  });
  const [scale, setScale] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [invert, setInvert] = useState(() => localStorage.getItem('folio.pdfInvert') === '1');
  const [error, setError] = useState<string | null>(null);
  const [zoomMenu, setZoomMenu] = useState<HTMLElement | null>(null);
  const pendingHighlight = useRef<SyncHighlight | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const visibleRef = useRef(new Set<number>());
  const historyRef = useRef<ViewPos[]>([]);
  const [canGoBack, setCanGoBack] = useState(false);
  const lastLinkClick = useRef(0);

  useEffect(() => {
    localStorage.setItem(`folio.zoom.${persistKey}`, String(zoomMode));
  }, [zoomMode, persistKey]);
  useEffect(() => {
    localStorage.setItem('folio.pdfInvert', invert ? '1' : '0');
  }, [invert]);

  const computeScale = useCallback(() => {
    const container = scrollRef.current;
    const slots = slotsRef.current;
    if (!container || !slots.length) return 1;
    const maxW = Math.max(...slots.map((s) => s.width));
    const maxH = Math.max(...slots.map((s) => s.height));
    if (zoomMode === 'fit') return Math.max(0.25, (container.clientWidth - 48) / maxW);
    if (zoomMode === 'page') return Math.max(0.25, Math.min((container.clientWidth - 48) / maxW, (container.clientHeight - 40) / maxH));
    return zoomMode * (96 / 72);
  }, [zoomMode]);

  /** Clickable overlay for the page's link annotations (TOC, \ref, \cite, URLs). Positioned in %, so zoom-independent. */
  const buildLinks = useCallback(async (slot: PageSlot, doc: PDFDocumentProxy) => {
    if (slot.linksDoc === doc || !slot.page) return;
    slot.linksDoc = doc;
    const page = slot.page;
    const annots = await page.getAnnotations({ intent: 'display' }).catch(() => []);
    if (docRef.current !== doc) return;
    const vp = page.getViewport({ scale: 1 });
    const layer = document.createElement('div');
    layer.className = 'pdf-links';
    for (const a of annots) {
      if (a.subtype !== 'Link' || !a.rect || (!a.dest && !a.url)) continue;
      const [ax, ay] = vp.convertToViewportPoint(a.rect[0], a.rect[1]);
      const [bx, by] = vp.convertToViewportPoint(a.rect[2], a.rect[3]);
      const [x1, y1, x2, y2] = [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
      const el = document.createElement('a');
      el.className = 'pdf-link';
      el.draggable = false;
      el.style.left = `${(x1 / vp.width) * 100}%`;
      el.style.top = `${(y1 / vp.height) * 100}%`;
      el.style.width = `${((x2 - x1) / vp.width) * 100}%`;
      el.style.height = `${((y2 - y1) / vp.height) * 100}%`;
      if (a.url) {
        el.href = a.url;
        el.target = '_blank';
        el.rel = 'noopener noreferrer';
        el.title = a.url;
      } else linkDests.set(el, a.dest);
      layer.appendChild(el);
    }
    slot.linkLayer?.remove();
    slot.linkLayer = layer;
    slot.el.appendChild(layer);
  }, []);

  const renderSlot = useCallback(async (idx: number) => {
    const slot = slotsRef.current[idx];
    const doc = docRef.current;
    if (!slot || !doc) return;
    const s = scaleRef.current;
    if (slot.rendering || Math.abs(slot.renderedScale - s) < 0.001) return;
    slot.rendering = true;
    try {
      if (!slot.page) slot.page = await doc.getPage(idx + 1);
      const page = slot.page;
      buildLinks(slot, doc);
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const vp = page.getViewport({ scale: s * dpr });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      canvas.style.width = `${slot.width * s}px`;
      canvas.style.height = `${slot.height * s}px`;
      await page.render({ canvas, viewport: vp }).promise;
      if (docRef.current !== doc) return;
      const old = slot.el.querySelector('canvas');
      if (old) old.replaceWith(canvas);
      else slot.el.prepend(canvas);
      slot.renderedScale = s;
      // text layer for selection & copy
      const tl = document.createElement('div');
      tl.className = 'textLayer';
      const cssVp = page.getViewport({ scale: s });
      slot.el.style.setProperty('--scale-factor', String(s));
      slot.el.style.setProperty('--total-scale-factor', String(s));
      slot.el.style.setProperty('--scale-round-x', '1px');
      slot.el.style.setProperty('--scale-round-y', '1px');
      const textLayer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport: cssVp });
      await textLayer.render().catch(() => {});
      if (docRef.current !== doc) return;
      slot.textLayer?.remove();
      slot.textLayer = tl;
      slot.el.appendChild(tl);
    } catch (e) {
      if ((e as Error)?.name !== 'RenderingCancelledException') console.warn(e);
    } finally {
      slot.rendering = false;
      // scale may have changed while rendering
      if (Math.abs(slot.renderedScale - scaleRef.current) > 0.001 && visibleRef.current.has(idx)) renderSlot(idx);
    }
  }, [buildLinks]);

  const layout = useCallback(
    (keepAnchor = true) => {
      const container = scrollRef.current;
      if (!container) return;
      const prev = scaleRef.current;
      const next = computeScale();
      // keep the point at the top of the viewport stable
      const ratio = keepAnchor && prev ? container.scrollTop / Math.max(1, container.scrollHeight) : 0;
      scaleRef.current = next;
      setScale(next);
      for (const slot of slotsRef.current) {
        slot.el.style.width = `${slot.width * next}px`;
        slot.el.style.height = `${slot.height * next}px`;
        const c = slot.el.querySelector('canvas');
        if (c) {
          c.style.width = `${slot.width * next}px`;
          c.style.height = `${slot.height * next}px`;
        }
        if (slot.textLayer && Math.abs(slot.renderedScale - next) > 0.001) slot.textLayer.style.display = 'none';
      }
      if (keepAnchor) container.scrollTop = ratio * container.scrollHeight;
      for (const idx of visibleRef.current) renderSlot(idx);
    },
    [computeScale, renderSlot],
  );

  // Load document whenever url changes
  useEffect(() => {
    if (!url) {
      docRef.current?.loadingTask.destroy();
      docRef.current = null;
      slotsRef.current = [];
      pagesRef.current?.replaceChildren();
      setNumPages(0);
      historyRef.current = [];
      setCanGoBack(false);
      return;
    }
    let cancelled = false;
    const task = pdfjs.getDocument({ url });
    task.promise
      .then(async (doc) => {
        if (cancelled) return doc.loadingTask.destroy();
        const container = scrollRef.current!;
        const pagesEl = pagesRef.current!;
        const ratio = container.scrollHeight ? container.scrollTop / container.scrollHeight : 0;
        const scrollLeft = container.scrollLeft;
        // measure all pages first (cheap) so the layout doesn't jump
        const sizes: { w: number; h: number }[] = [];
        const firstPages: PDFPageProxy[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const p = await doc.getPage(i);
          const vp = p.getViewport({ scale: 1 });
          sizes.push({ w: vp.width, h: vp.height });
          firstPages.push(p);
        }
        if (cancelled) return doc.loadingTask.destroy();
        const oldDoc = docRef.current;
        docRef.current = doc;
        observerRef.current?.disconnect();
        visibleRef.current.clear();
        const oldSlots = slotsRef.current;
        const slots: PageSlot[] = sizes.map((s, i) => {
          // reuse existing page elements (keeps old canvas visible until the new one is drawn)
          const el = oldSlots[i]?.el ?? document.createElement('div');
          el.className = 'pdf-page';
          el.dataset.page = String(i + 1);
          el.querySelectorAll('.sync-highlight').forEach((n) => n.remove());
          return {
            el,
            page: firstPages[i],
            width: s.w,
            height: s.h,
            renderedScale: 0,
            rendering: false,
            textLayer: oldSlots[i]?.textLayer ?? null,
            linkLayer: oldSlots[i]?.linkLayer ?? null,
            linksDoc: null,
          };
        });
        for (let i = slots.length; i < oldSlots.length; i++) oldSlots[i].el.remove();
        for (const s of slots) if (!s.el.parentElement) pagesEl.appendChild(s.el);
        slotsRef.current = slots;
        setNumPages(doc.numPages);
        setError(null);
        layout(false);
        container.scrollTop = ratio * container.scrollHeight;
        container.scrollLeft = scrollLeft;
        const io = new IntersectionObserver(
          (entries) => {
            for (const e of entries) {
              const idx = Number((e.target as HTMLElement).dataset.page) - 1;
              if (e.isIntersecting) {
                visibleRef.current.add(idx);
                renderSlot(idx);
              } else visibleRef.current.delete(idx);
            }
          },
          { root: container, rootMargin: '600px 0px' },
        );
        slots.forEach((s) => io.observe(s.el));
        observerRef.current = io;
        oldDoc?.loadingTask.destroy();
        if (pendingHighlight.current) {
          const h = pendingHighlight.current;
          pendingHighlight.current = null;
          drawHighlight(h);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e?.message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  useEffect(() => () => {
    observerRef.current?.disconnect();
    docRef.current?.loadingTask.destroy();
  }, []);

  // Re-layout on zoom change and container resize
  useEffect(() => {
    layout(true);
  }, [zoomMode]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (zoomMode === 'fit' || zoomMode === 'page') layout(true);
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [layout, zoomMode]);

  // Track current page
  const onScroll = () => {
    const container = scrollRef.current;
    if (!container) return;
    const mid = container.scrollTop + container.clientHeight * 0.35;
    let cur = 1;
    for (const [i, s] of slotsRef.current.entries()) {
      if (s.el.offsetTop <= mid) cur = i + 1;
      else break;
    }
    if (cur !== currentPage) {
      setCurrentPage(cur);
      setPageInput(String(cur));
    }
  };

  const goToPage = (n: number) => {
    const slot = slotsRef.current[n - 1];
    if (slot && scrollRef.current) scrollRef.current.scrollTo({ top: slot.el.offsetTop - 16, behavior: 'smooth' });
  };

  const drawHighlight = (h: SyncHighlight) => {
    const slot = slotsRef.current[h.page - 1];
    const container = scrollRef.current;
    if (!slot || !container) {
      pendingHighlight.current = h;
      return;
    }
    const s = scaleRef.current;
    slot.el.querySelectorAll('.sync-highlight').forEach((n) => n.remove());
    for (const r of h.rects) {
      const d = document.createElement('div');
      d.className = 'sync-highlight';
      d.style.left = `${r.x * s - 3}px`;
      d.style.top = `${r.y * s - 2}px`;
      d.style.width = `${r.w * s + 6}px`;
      d.style.height = `${r.h * s + 4}px`;
      slot.el.appendChild(d);
      setTimeout(() => d.remove(), 2600);
    }
    const first = h.rects[0];
    if (first) {
      const target = slot.el.offsetTop + first.y * s - container.clientHeight / 3;
      const visibleTop = container.scrollTop;
      const y = slot.el.offsetTop + first.y * s;
      if (y < visibleTop + 40 || y > visibleTop + container.clientHeight - 40) container.scrollTo({ top: target, behavior: 'smooth' });
    }
  };

  useImperativeHandle(ref, () => ({ showHighlight: drawHighlight }), []);

  /** Current reading position, independent of zoom (page index + offset in bp). */
  const currentPos = (): ViewPos | null => {
    const c = scrollRef.current;
    const slots = slotsRef.current;
    if (!c || !slots.length) return null;
    let page = 0;
    for (const [i, s] of slots.entries()) {
      if (s.el.offsetTop <= c.scrollTop) page = i;
      else break;
    }
    const s = scaleRef.current;
    return { page, y: (c.scrollTop - slots[page].el.offsetTop) / s, x: c.scrollLeft / s };
  };

  const goBack = () => {
    const pos = historyRef.current.pop();
    setCanGoBack(historyRef.current.length > 0);
    const c = scrollRef.current;
    const slot = pos && slotsRef.current[pos.page];
    if (!pos || !c || !slot) return;
    const s = scaleRef.current;
    c.scrollTop = slot.el.offsetTop + pos.y * s;
    c.scrollLeft = pos.x * s;
  };

  const followLink = async (dest: unknown) => {
    const doc = docRef.current;
    const c = scrollRef.current;
    if (!doc || !c) return;
    const target = await resolveDest(doc, dest).catch(() => null);
    const slot = target && slotsRef.current[target.pageIdx];
    if (!target || !slot || docRef.current !== doc) return;
    if (!slot.page) slot.page = await doc.getPage(target.pageIdx + 1);
    const pos = currentPos();
    if (pos) {
      historyRef.current = [...historyRef.current.slice(-49), pos];
      setCanGoBack(true);
    }
    const vp = slot.page.getViewport({ scale: 1 });
    const [px, py] = target.y != null ? vp.convertToViewportPoint(target.x ?? 0, target.y) : [0, 0];
    const s = scaleRef.current;
    c.scrollTop = slot.el.offsetTop + py * s - 48;
    if (target.x != null) {
      const left = slot.el.offsetLeft + px * s;
      if (left < c.scrollLeft || left > c.scrollLeft + c.clientWidth - 60) c.scrollLeft = left - 24;
    }
    // briefly mark the line the link points to (heading, caption, bibliography entry …)
    if (target.y == null) return;
    const line = await lineBelow(slot.page, py).catch(() => null);
    if (line && docRef.current === doc) drawHighlight({ page: target.pageIdx + 1, rects: [line], key: Date.now() });
  };

  const onClick = (e: React.MouseEvent) => {
    const link = (e.target as HTMLElement).closest('.pdf-link');
    if (!link) return;
    // in a double-click only the first click counts – the second one would hit whatever is under the cursor after the jump
    if (e.detail > 1) return e.preventDefault();
    lastLinkClick.current = performance.now();
    if (!linkDests.has(link)) return; // external URL: the browser opens it in a new tab
    e.preventDefault();
    followLink(linkDests.get(link));
  };
  const justFollowedLink = () => performance.now() - lastLinkClick.current < 800;

  const onMouseDown = (e: React.MouseEvent) => {
    // don't select a word at the jump target when a link was double-clicked
    if (e.detail > 1 && justFollowedLink()) e.preventDefault();
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.pdf-link') || justFollowedLink()) return;
    const pageEl = (e.target as HTMLElement).closest<HTMLElement>('.pdf-page');
    if (!pageEl) return;
    const rect = pageEl.getBoundingClientRect();
    const s = scaleRef.current;
    window.getSelection()?.removeAllRanges();
    onInverse(Number(pageEl.dataset.page), (e.clientX - rect.left) / s, (e.clientY - rect.top) / s);
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const cur = scaleRef.current / (96 / 72);
    const factor = Math.exp(-e.deltaY * 0.0025);
    setZoomMode(Math.max(0.25, Math.min(5, Math.round(cur * factor * 100) / 100)));
  };
  // React's onWheel is passive; attach a native listener to be able to preventDefault
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const h = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    };
    el.addEventListener('wheel', h, { passive: false });
    return () => el.removeEventListener('wheel', h);
  }, []);

  const zoomStep = (dir: 1 | -1) => {
    const cur = scaleRef.current / (96 / 72);
    const next = dir > 0 ? ZOOMS.find((z) => z > cur + 0.01) ?? 3 : [...ZOOMS].reverse().find((z) => z < cur - 0.01) ?? 0.5;
    setZoomMode(next);
  };

  const pct = Math.round((scale / (96 / 72)) * 100);

  return (
    <>
      <div className="pdf-toolbar">
        <div className="page-info">
          <button className="icon-btn sm" onClick={() => goToPage(Math.max(1, currentPage - 1))} disabled={currentPage <= 1} title="Vorherige Seite">
            <ChevronUp size={15} />
          </button>
          <button className="icon-btn sm" onClick={() => goToPage(Math.min(numPages, currentPage + 1))} disabled={currentPage >= numPages} title="Nächste Seite">
            <ChevronDown size={15} />
          </button>
          <input
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') goToPage(Math.max(1, Math.min(numPages, Number(pageInput) || 1)));
            }}
            onBlur={() => setPageInput(String(currentPage))}
          />
          <span>/ {numPages || '–'}</span>
          {canGoBack && (
            <button className="icon-btn sm" onClick={goBack} title="Zurück zur Stelle vor dem Link">
              <CornerUpLeft size={14} />
            </button>
          )}
        </div>
        <div className="spacer" />
        <button className="icon-btn sm" onClick={() => zoomStep(-1)} title="Verkleinern">
          <ZoomOut size={15} />
        </button>
        <button className="zoom-label" onClick={(e) => setZoomMenu(e.currentTarget)}>
          {pct}%
        </button>
        <button className="icon-btn sm" onClick={() => zoomStep(1)} title="Vergrößern">
          <ZoomIn size={15} />
        </button>
        <button className={`icon-btn sm ${zoomMode === 'fit' ? 'active' : ''}`} onClick={() => setZoomMode('fit')} title="An Breite anpassen">
          <Maximize2 size={14} />
        </button>
        <div className="spacer" />
        <button className={`icon-btn sm ${invert ? 'active' : ''}`} onClick={() => setInvert(!invert)} title="PDF im Dunkelmodus abdunkeln">
          <Moon size={14} />
        </button>
        <a className="icon-btn sm" href={downloadUrl ?? undefined} title="PDF herunterladen" style={{ pointerEvents: downloadUrl ? 'auto' : 'none', opacity: downloadUrl ? 1 : 0.35 }}>
          <Download size={15} />
        </a>
      </div>
      {zoomMenu && (
        <Popover anchor={zoomMenu} onClose={() => setZoomMenu(null)} align="center">
          <Menu
            onClose={() => setZoomMenu(null)}
            items={[
              { label: 'An Breite anpassen', onClick: () => setZoomMode('fit') },
              { label: 'Ganze Seite', onClick: () => setZoomMode('page') },
              'sep',
              ...[0.5, 0.75, 1, 1.25, 1.5, 2].map((z) => ({ label: `${Math.round(z * 100)} %`, onClick: () => setZoomMode(z) })),
            ]}
          />
        </Popover>
      )}
      <div
        className="pdf-scroll"
        ref={scrollRef}
        onScroll={onScroll}
        onClick={onClick}
        onMouseDown={onMouseDown}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
      >
        {compiling && <div className="compiling-bar" />}
        <div className={`pdf-pages ${invert ? 'invert' : ''}`} ref={pagesRef} style={{ display: url && !error ? undefined : 'none' }} />
        {(!url || error) && (
          <div className="pdf-empty">
            <div className="big">{compiling ? <div className="spinner" style={{ width: 22, height: 22 }} /> : <FileText size={28} />}</div>
            <h3>{compiling ? 'Wird kompiliert …' : error ? 'PDF konnte nicht geladen werden' : emptyTitle}</h3>
            <p>{compiling ? 'Beim ersten Mal kann das etwas dauern.' : error ?? emptyText}</p>
          </div>
        )}
      </div>
    </>
  );
});
