import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * Minimal SyncTeX parser. Produces, per page, a flat list of boxes/nodes with
 * PDF coordinates in big points (1/72 in), origin top-left.
 */
const cache = new Map(); // file -> { mtime, data }

export async function loadSynctex(outDir, jobBase, root) {
  const gz = path.join(outDir, jobBase + '.synctex.gz');
  const plain = path.join(outDir, jobBase + '.synctex');
  let file = null;
  let stat = null;
  for (const f of [gz, plain]) {
    try {
      stat = await fs.stat(f);
      file = f;
      break;
    } catch {}
  }
  if (!file) return null;
  const cached = cache.get(file);
  if (cached && cached.mtime === stat.mtimeMs) return cached.data;
  let buf = await fs.readFile(file);
  if (file.endsWith('.gz')) buf = zlib.gunzipSync(buf);
  const data = parse(buf.toString('utf8'), root);
  cache.set(file, { mtime: stat.mtimeMs, data });
  return data;
}

function parse(text, root) {
  const inputs = new Map(); // tag -> relative path
  const pages = new Map(); // page -> nodes[]
  let unit = 1;
  let xOffset = 0;
  let yOffset = 0;
  let mag = 1000;
  let page = 0;
  let nodes = null;
  const boxStack = [];
  let last = { tag: 0, line: 0, h: 0, v: 0, W: 0, H: 0, D: 0 };

  const toBp = (sp) => ((sp * unit) / 65536) * (72 / 72.27) * (mag / 1000);

  const parseRec = (body) => {
    // tag,line[,column]:h,v[:W,H,D]
    const [loc, pos, dims] = body.split(':');
    if (!loc || !pos) return null;
    const [tagS, lineS] = loc.split(',');
    const [hS, vS] = pos.split(',');
    const rec = {
      tag: tagS === '=' ? last.tag : parseInt(tagS, 10),
      line: lineS === '=' ? last.line : parseInt(lineS, 10),
      h: hS === '=' ? last.h : parseInt(hS, 10),
      v: vS === '=' ? last.v : parseInt(vS, 10),
      W: 0,
      H: 0,
      D: 0,
    };
    if (dims) {
      const [W, H, D] = dims.split(',');
      rec.W = W === '=' ? last.W : parseInt(W, 10) || 0;
      rec.H = H === '=' ? last.H : parseInt(H, 10) || 0;
      rec.D = D === '=' ? last.D : parseInt(D, 10) || 0;
    }
    last = rec;
    return rec;
  };

  const mkNode = (type, r, depth) => {
    const x = toBp(r.h + xOffset);
    const baseline = toBp(r.v + yOffset);
    const w = toBp(r.W);
    const top = baseline - toBp(r.H);
    const bottom = baseline + toBp(r.D);
    return { type, tag: r.tag, line: r.line, x, y: top, w, h: Math.max(bottom - top, 0), baseline, depth };
  };

  const lines = text.split('\n');
  let inContent = false;
  for (const raw of lines) {
    if (!raw) continue;
    if (!inContent) {
      if (raw.startsWith('Input:')) {
        const m = raw.match(/^Input:(\d+):(.*)$/);
        if (m) inputs.set(+m[1], relPath(m[2], root));
      } else if (raw.startsWith('Unit:')) unit = parseFloat(raw.slice(5)) || 1;
      else if (raw.startsWith('X Offset:')) xOffset = parseInt(raw.slice(9), 10) || 0;
      else if (raw.startsWith('Y Offset:')) yOffset = parseInt(raw.slice(9), 10) || 0;
      else if (raw.startsWith('Magnification:')) mag = parseFloat(raw.slice(14)) || 1000;
      else if (raw.startsWith('Content:')) inContent = true;
      continue;
    }
    const c = raw[0];
    if (raw.startsWith('Input:')) {
      const m = raw.match(/^Input:(\d+):(.*)$/);
      if (m) inputs.set(+m[1], relPath(m[2], root));
      continue;
    }
    if (raw.startsWith('Postamble')) break;
    switch (c) {
      case '{':
        page = parseInt(raw.slice(1), 10);
        nodes = [];
        pages.set(page, nodes);
        boxStack.length = 0;
        break;
      case '}':
        nodes = null;
        break;
      case '[':
      case '(': {
        const r = parseRec(raw.slice(1));
        if (r && nodes) {
          const n = mkNode(c === '[' ? 'vbox' : 'hbox', r, boxStack.length);
          n.parent = boxStack[boxStack.length - 1] || null;
          nodes.push(n);
          boxStack.push(n);
        }
        break;
      }
      case ']':
      case ')':
        boxStack.pop();
        break;
      case 'v':
      case 'h':
      case 'x':
      case 'k':
      case 'g':
      case '$': {
        const r = parseRec(raw.slice(1));
        if (r && nodes) {
          const type = { v: 'void-vbox', h: 'void-hbox', x: 'current', k: 'kern', g: 'glue', $: 'math' }[c];
          const n = mkNode(type, r, boxStack.length);
          if (c === 'k') {
            // kern: width is horizontal extent, no height
            n.h = 0;
            n.y = n.baseline;
          }
          n.parent = boxStack[boxStack.length - 1] || null;
          nodes.push(n);
        }
        break;
      }
      default:
        break;
    }
  }
  return { inputs, pages };
}

function relPath(p, root) {
  let f = p.trim();
  if (path.isAbsolute(f)) {
    f = path.relative(root, f);
  }
  f = path.normalize(f).replace(/\\/g, '/').replace(/^\.\//, '');
  return f;
}

/** file + line → highlight rectangles on a page. */
export function forward(data, file, line) {
  const tags = [...data.inputs.entries()].filter(([, f]) => f === file || f === file.replace(/\.tex$/, '')).map(([t]) => t);
  if (!tags.length) return null;
  const tagSet = new Set(tags);
  // Look for exact line, then search outwards for the nearest line that produced output
  for (let delta = 0; delta < 60; delta++) {
    for (const ln of delta === 0 ? [line] : [line + delta, line - delta]) {
      if (ln < 1) continue;
      let best = null;
      for (const [page, nodes] of data.pages) {
        const hits = nodes.filter((n) => tagSet.has(n.tag) && n.line === ln && (n.type === 'hbox' || n.type === 'void-hbox' || n.type === 'math' || n.type === 'glue' || n.type === 'kern' || n.type === 'current'));
        if (!hits.length) continue;
        if (!best || page < best.page) best = { page, hits };
      }
      if (best) {
        // highlight whole typeset lines: climb from each hit to the outermost enclosing hbox
        const lineBox = (n) => {
          let b = n.type === 'hbox' ? n : n.parent && n.parent.type === 'hbox' ? n.parent : null;
          while (b && b.parent && b.parent.type === 'hbox') b = b.parent;
          return b;
        };
        const boxes = [...new Set(best.hits.map(lineBox).filter((b) => b && b.w > 0))];
        const rects = (boxes.length ? boxes : best.hits).map((n) => ({
          x: n.x,
          y: n.type === 'hbox' || n.type === 'void-hbox' ? n.y : n.baseline - 10,
          w: Math.max(n.w, 4),
          h: n.type === 'hbox' || n.type === 'void-hbox' ? Math.max(n.h, 8) : 12,
        }));
        return { page: best.page, rects: mergeRects(rects), line: ln };
      }
    }
  }
  return null;
}

function mergeRects(rects) {
  // Deduplicate rects that are identical/nested to keep the overlay tidy
  const out = [];
  for (const r of rects.sort((a, b) => b.w * b.h - a.w * a.h)) {
    if (out.some((o) => r.x >= o.x - 0.5 && r.y >= o.y - 0.5 && r.x + r.w <= o.x + o.w + 0.5 && r.y + r.h <= o.y + o.h + 0.5)) continue;
    out.push(r);
  }
  return out.slice(0, 40);
}

/** page + point (bp, origin top-left) → file + line. */
export function inverse(data, page, x, y) {
  const nodes = data.pages.get(page);
  if (!nodes) return null;
  // smallest hbox containing the point
  let box = null;
  for (const n of nodes) {
    if (n.type !== 'hbox') continue;
    if (x >= n.x && x <= n.x + n.w && y >= n.y && y <= n.y + n.h) {
      if (!box || n.w * n.h < box.w * box.h) box = n;
    }
  }
  let best = null;
  if (box) {
    // leaf nodes on this line, closest one left of the click
    let bestDist = Infinity;
    for (const n of nodes) {
      if (n.parent !== box) continue;
      if (n.type === 'hbox' || n.type === 'vbox') continue;
      const dx = x - n.x;
      const dist = dx >= 0 ? dx : -dx * 3;
      if (dist < bestDist) {
        bestDist = dist;
        best = n;
      }
    }
    if (!best) best = box;
  } else {
    let bestDist = Infinity;
    for (const n of nodes) {
      if (n.type === 'vbox') continue;
      const cx = Math.max(n.x, Math.min(x, n.x + n.w));
      const cy = Math.max(n.y, Math.min(y, n.y + Math.max(n.h, 1)));
      const d = Math.hypot(x - cx, y - cy);
      if (d < bestDist) {
        bestDist = d;
        best = n;
      }
    }
  }
  if (!best) return null;
  const file = data.inputs.get(best.tag);
  if (!file) return null;
  return { file, line: best.line };
}
