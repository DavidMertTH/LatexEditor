import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };

const thumbCache = new Map<string, Promise<HTMLCanvasElement>>();

/** Render the first page of a PDF (e.g. an included graphic) into a canvas. */
export function renderPdfThumb(url: string, width = 600): Promise<HTMLCanvasElement> {
  const key = url + '@' + width;
  let p = thumbCache.get(key);
  if (!p) {
    p = (async () => {
      const doc = await pdfjs.getDocument({ url }).promise;
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const scale = (width / base.width) * Math.min(window.devicePixelRatio || 1, 2);
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      await page.render({ canvas, viewport: vp }).promise;
      doc.loadingTask.destroy();
      return canvas;
    })();
    thumbCache.set(key, p);
    p.catch(() => thumbCache.delete(key));
  }
  return p;
}

export function clearThumbCache() {
  thumbCache.clear();
}
