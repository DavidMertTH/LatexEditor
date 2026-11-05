import express from 'express';
import { WebSocketServer } from 'ws';
import chokidar from 'chokidar';
import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { compile, cancelCompile, availableEngines, defaultEngine, detectTools, OUT_DIR } from './compile.js';
import { loadSynctex, forward, inverse } from './synctex.js';
import { buildIndex } from './indexer.js';
import { TEMPLATES } from './templates.js';
import * as gitSync from './git.js';
import { encodeId, decodeId, safeJoin, exists, readJson, writeJson, walk, isTextFile, IGNORED_NAMES } from './util.js';

const APP_ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT || 4242);
const HOST = process.env.HOST || '127.0.0.1';
const WORKSPACE = path.resolve(process.env.LATEX_WORKSPACE || path.join(APP_ROOT, 'projects'));
const STATE_FILE = path.join(APP_ROOT, '.editor-state.json');
const DIST = path.join(APP_ROOT, 'dist');

await fs.mkdir(WORKSPACE, { recursive: true });

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20mb' }));

// ── helpers ────────────────────────────────────────────────────────────────
const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    if (!err.status) console.error(err);
    res.status(err.status || 500).json({ error: err.message || String(err) });
  });

const httpError = (status, message) => Object.assign(new Error(message), { status });

async function loadState() {
  return readJson(STATE_FILE, { recent: [] });
}

async function projectSettings(root) {
  const s = await readJson(path.join(root, '.latexeditor.json'), {});
  if (!s.mainFile || !(await exists(path.join(root, s.mainFile)))) s.mainFile = await guessMainFile(root);
  if (!s.engine) s.engine = (await guessEngine(root, s.mainFile)) || defaultEngine();
  if (s.autoCompile === undefined) s.autoCompile = true;
  return s;
}

async function guessMainFile(root) {
  const files = (await fs.readdir(root).catch(() => [])).filter((f) => f.endsWith('.tex'));
  for (const f of ['main.tex', 'document.tex', 'paper.tex', 'thesis.tex']) if (files.includes(f)) return f;
  for (const f of files) {
    const txt = await fs.readFile(path.join(root, f), 'utf8').catch(() => '');
    if (/\\documentclass/.test(txt)) return f;
  }
  return files[0] || 'main.tex';
}

async function guessEngine(root, mainFile) {
  const txt = await fs.readFile(path.join(root, mainFile), 'utf8').catch(() => '');
  const engines = availableEngines();
  const has = (id) => engines.find((e) => e.id === id)?.available;
  if (/\\usepackage(\[[^\]]*\])?\{(fontspec|unicode-math|polyglossia)\}/.test(txt)) {
    if (has('xelatex')) return 'xelatex';
    if (has('lualatex')) return 'lualatex';
    if (has('tectonic')) return 'tectonic';
  }
  return null;
}

async function describeProject(root) {
  const stat = await fs.stat(root);
  const settings = await projectSettings(root);
  let modified = stat.mtimeMs;
  try {
    modified = Math.max(modified, (await fs.stat(path.join(root, settings.mainFile))).mtimeMs);
  } catch {}
  const hasPdf = await exists(path.join(root, OUT_DIR, path.basename(settings.mainFile, '.tex') + '.pdf'));
  return {
    id: encodeId(root),
    name: path.basename(root),
    path: root,
    mainFile: settings.mainFile,
    modified,
    inWorkspace: path.dirname(root) === WORKSPACE,
    hasPdf,
  };
}

function projectRoot(req) {
  const root = decodeId(req.params.id);
  if (!path.isAbsolute(root) || !existsSync(root)) throw httpError(404, 'Projekt nicht gefunden');
  return root;
}

// Writes made by the editor itself must not echo back as "external change".
const recentWrites = new Map(); // abs path -> timestamp
function markWrite(abs) {
  recentWrites.set(abs, Date.now());
}

// ── projects ───────────────────────────────────────────────────────────────
app.get(
  '/api/info',
  wrap(async (req, res) => {
    res.json({ workspace: WORKSPACE, home: os.homedir(), engines: availableEngines(), tools: detectTools(true), templates: Object.entries(TEMPLATES).map(([id, t]) => ({ id, name: t.name, description: t.description })) });
  }),
);

app.get(
  '/api/projects',
  wrap(async (req, res) => {
    const entries = await fs.readdir(WORKSPACE, { withFileTypes: true });
    const roots = new Set(entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => path.join(WORKSPACE, e.name)));
    const state = await loadState();
    for (const r of state.recent || []) if (existsSync(r)) roots.add(r);
    const projects = [];
    for (const r of roots) {
      try {
        projects.push(await describeProject(r));
      } catch {}
    }
    projects.sort((a, b) => b.modified - a.modified);
    res.json(projects);
  }),
);

app.post(
  '/api/projects',
  wrap(async (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!name || /[\/\\]/.test(name) || name.startsWith('.')) throw httpError(400, 'Ungültiger Projektname');
    const root = path.join(WORKSPACE, name);
    if (await exists(root)) throw httpError(409, 'Ein Projekt mit diesem Namen existiert bereits');
    const tpl = TEMPLATES[req.body.template] || TEMPLATES.article;
    await fs.mkdir(root, { recursive: true });
    for (const [file, content] of Object.entries(tpl.files)) {
      const abs = safeJoin(root, file);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, typeof content === 'function' ? content(name) : content);
    }
    await writeJson(path.join(root, '.latexeditor.json'), { mainFile: 'main.tex', engine: tpl.engine && availableEngines().find((e) => e.id === tpl.engine)?.available ? tpl.engine : defaultEngine() });
    res.json(await describeProject(root));
  }),
);

app.post(
  '/api/projects/open',
  wrap(async (req, res) => {
    let p = String(req.body.path || '').trim();
    if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
    p = path.resolve(p);
    let st;
    try {
      st = await fs.stat(p);
    } catch {
      throw httpError(404, 'Ordner nicht gefunden');
    }
    if (st.isFile()) p = path.dirname(p);
    const state = await loadState();
    state.recent = [p, ...(state.recent || []).filter((r) => r !== p)].slice(0, 30);
    await writeJson(STATE_FILE, state);
    res.json(await describeProject(p));
  }),
);

app.get(
  '/api/browse',
  wrap(async (req, res) => {
    let p = String(req.query.path || os.homedir());
    if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
    p = path.resolve(p);
    const entries = await fs.readdir(p, { withFileTypes: true }).catch(() => {
      throw httpError(404, 'Ordner nicht lesbar');
    });
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort((a, b) => a.localeCompare(b, 'de'));
    const texCount = entries.filter((e) => e.isFile() && e.name.endsWith('.tex')).length;
    res.json({ path: p, parent: path.dirname(p) !== p ? path.dirname(p) : null, dirs, texCount });
  }),
);

app.delete(
  '/api/projects/:id',
  wrap(async (req, res) => {
    const root = decodeId(req.params.id);
    const state = await loadState();
    state.recent = (state.recent || []).filter((r) => r !== root);
    await writeJson(STATE_FILE, state);
    if (path.dirname(root) === WORKSPACE && req.query.trash === '1') {
      // never hard-delete: move into the workspace trash
      const trash = path.join(WORKSPACE, '.trash');
      await fs.mkdir(trash, { recursive: true });
      await fs.rename(root, path.join(trash, `${path.basename(root)}-${Date.now()}`));
    }
    res.json({ ok: true });
  }),
);

// ── project files ──────────────────────────────────────────────────────────
app.get(
  '/api/p/:id',
  wrap(async (req, res) => {
    const root = projectRoot(req);
    res.json({ ...(await describeProject(root)), settings: await projectSettings(root), tree: await walk(root), engines: availableEngines() });
  }),
);

app.get(
  '/api/p/:id/tree',
  wrap(async (req, res) => {
    res.json(await walk(projectRoot(req)));
  }),
);

app.put(
  '/api/p/:id/settings',
  wrap(async (req, res) => {
    const root = projectRoot(req);
    const current = await readJson(path.join(root, '.latexeditor.json'), {});
    const next = { ...current, ...req.body };
    await writeJson(path.join(root, '.latexeditor.json'), next);
    res.json(await projectSettings(root));
  }),
);

app.get(
  '/api/p/:id/file',
  wrap(async (req, res) => {
    const root = projectRoot(req);
    const abs = safeJoin(root, req.query.path);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat || !stat.isFile()) throw httpError(404, 'Datei nicht gefunden');
    if (!isTextFile(abs) && stat.size > 0) throw httpError(415, 'Binärdatei');
    res.json({ path: req.query.path, content: await fs.readFile(abs, 'utf8'), mtime: stat.mtimeMs });
  }),
);

app.put(
  '/api/p/:id/file',
  express.text({ limit: '20mb', type: '*/*' }),
  wrap(async (req, res) => {
    const root = projectRoot(req);
    const abs = safeJoin(root, req.query.path);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    markWrite(abs);
    await fs.writeFile(abs, typeof req.body === 'string' ? req.body : '', 'utf8');
    markWrite(abs);
    const stat = await fs.stat(abs);
    res.json({ ok: true, mtime: stat.mtimeMs });
  }),
);

app.get(
  '/api/p/:id/raw/*splat',
  wrap(async (req, res) => {
    const root = projectRoot(req);
    const rel = [].concat(req.params.splat).join('/');
    const abs = safeJoin(root, rel);
    if (!(await exists(abs))) throw httpError(404, 'Datei nicht gefunden');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(abs, { dotfiles: 'allow' });
  }),
);

app.post(
  '/api/p/:id/upload',
  express.raw({ limit: '200mb', type: '*/*' }),
  wrap(async (req, res) => {
    const root = projectRoot(req);
    const abs = safeJoin(root, req.query.path);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    markWrite(abs);
    await fs.writeFile(abs, req.body);
    res.json({ ok: true });
  }),
);

app.post(
  '/api/p/:id/fs',
  wrap(async (req, res) => {
    const root = projectRoot(req);
    const { op, path: rel, to } = req.body;
    const abs = safeJoin(root, rel);
    if (abs === path.resolve(root)) throw httpError(400, 'Ungültiger Pfad');
    switch (op) {
      case 'mkdir':
        await fs.mkdir(abs, { recursive: true });
        break;
      case 'create':
        if (await exists(abs)) throw httpError(409, 'Datei existiert bereits');
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, req.body.content ?? '');
        break;
      case 'rename': {
        const dest = safeJoin(root, to);
        if (await exists(dest)) throw httpError(409, 'Ziel existiert bereits');
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.rename(abs, dest);
        const s = await readJson(path.join(root, '.latexeditor.json'), {});
        if (s.mainFile === rel) await writeJson(path.join(root, '.latexeditor.json'), { ...s, mainFile: to });
        break;
      }
      case 'delete': {
        // move to project-local trash instead of deleting
        const trash = path.join(root, '.trash');
        await fs.mkdir(trash, { recursive: true });
        await fs.rename(abs, path.join(trash, `${Date.now()}-${path.basename(abs)}`));
        break;
      }
      default:
        throw httpError(400, 'Unbekannte Operation');
    }
    res.json({ ok: true, tree: await walk(root) });
  }),
);

app.get(
  '/api/p/:id/index',
  wrap(async (req, res) => {
    res.json(await buildIndex(projectRoot(req)));
  }),
);

// ── compile / pdf / synctex ────────────────────────────────────────────────
app.post(
  '/api/p/:id/compile',
  wrap(async (req, res) => {
    const root = projectRoot(req);
    const settings = await projectSettings(root);
    const result = await compile(root, { mainFile: settings.mainFile, engine: settings.engine });
    res.json({ ...result, engine: settings.engine, mainFile: settings.mainFile });
  }),
);

app.post(
  '/api/p/:id/compile/cancel',
  wrap(async (req, res) => {
    res.json({ cancelled: cancelCompile(projectRoot(req)) });
  }),
);

app.get(
  '/api/p/:id/output/:file',
  wrap(async (req, res) => {
    const root = projectRoot(req);
    const abs = safeJoin(path.join(root, OUT_DIR), req.params.file);
    if (!(await exists(abs))) throw httpError(404, 'Noch keine Ausgabe');
    res.setHeader('Cache-Control', 'no-store');
    if (req.query.download) res.attachment(req.params.file);
    res.sendFile(abs, { dotfiles: 'allow' });
  }),
);

app.get(
  '/api/p/:id/synctex/forward',
  wrap(async (req, res) => {
    const root = projectRoot(req);
    const settings = await projectSettings(root);
    const data = await loadSynctex(path.join(root, OUT_DIR), path.basename(settings.mainFile, '.tex'), root);
    if (!data) throw httpError(404, 'Keine SyncTeX-Daten – bitte zuerst kompilieren');
    res.json(forward(data, String(req.query.file), Number(req.query.line)) || null);
  }),
);

app.get(
  '/api/p/:id/synctex/inverse',
  wrap(async (req, res) => {
    const root = projectRoot(req);
    const settings = await projectSettings(root);
    const data = await loadSynctex(path.join(root, OUT_DIR), path.basename(settings.mainFile, '.tex'), root);
    if (!data) throw httpError(404, 'Keine SyncTeX-Daten – bitte zuerst kompilieren');
    res.json(inverse(data, Number(req.query.page), Number(req.query.x), Number(req.query.y)) || null);
  }),
);

// ── git / GitHub ───────────────────────────────────────────────────────────
app.get(
  '/api/p/:id/git',
  wrap(async (req, res) => {
    res.json(await gitSync.status(projectRoot(req)));
  }),
);

app.post(
  '/api/p/:id/git/pull',
  wrap(async (req, res) => {
    res.json(await gitSync.pull(projectRoot(req), { prefer: req.body?.prefer }));
  }),
);

app.post(
  '/api/p/:id/git/sync',
  wrap(async (req, res) => {
    res.json(await gitSync.sync(projectRoot(req), { message: req.body?.message, prefer: req.body?.prefer }));
  }),
);

app.post(
  '/api/p/:id/git/link',
  wrap(async (req, res) => {
    res.json(await gitSync.link(projectRoot(req), req.body?.url));
  }),
);

app.use('/api', (req, res) => res.status(404).json({ error: 'Unbekannter Endpunkt' }));

// ── static client ──────────────────────────────────────────────────────────
if (existsSync(DIST)) {
  app.use(express.static(DIST, { index: false }));
  app.get('/{*splat}', (req, res) => res.sendFile(path.join(DIST, 'index.html')));
} else {
  app.get('/', (req, res) => res.type('text').send('Client noch nicht gebaut. Starte mit "npm start" oder im Dev-Modus "npm run dev".'));
}

// ── live file watching over websockets ────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const watchers = new Map(); // root -> { watcher, clients:Set }

wss.on('connection', (socket, req) => {
  const url = new URL(req.url, 'http://x');
  let root;
  try {
    root = decodeId(url.searchParams.get('project'));
  } catch {
    return socket.close();
  }
  if (!path.isAbsolute(root) || !existsSync(root)) return socket.close();
  let entry = watchers.get(root);
  if (!entry) {
    const clients = new Set();
    const watcher = chokidar.watch(root, {
      ignoreInitial: true,
      ignored: (p) => {
        const rel = path.relative(root, p);
        return rel.split(path.sep).some((seg) => IGNORED_NAMES.has(seg) || (seg.startsWith('.') && seg !== '.latexmkrc'));
      },
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });
    const broadcast = (type, abs) => {
      const t = recentWrites.get(abs);
      if (type === 'change' && t && Date.now() - t < 1500) return;
      const msg = JSON.stringify({ type, path: path.relative(root, abs).split(path.sep).join('/') });
      for (const c of clients) if (c.readyState === 1) c.send(msg);
    };
    watcher.on('add', (p) => broadcast('add', p));
    watcher.on('addDir', (p) => broadcast('addDir', p));
    watcher.on('unlink', (p) => broadcast('unlink', p));
    watcher.on('unlinkDir', (p) => broadcast('unlinkDir', p));
    watcher.on('change', (p) => broadcast('change', p));
    entry = { watcher, clients };
    watchers.set(root, entry);
  }
  entry.clients.add(socket);
  socket.on('close', () => {
    entry.clients.delete(socket);
    if (!entry.clients.size) {
      entry.watcher.close();
      watchers.delete(root);
    }
  });
});

server.listen(PORT, HOST, () => {
  const engines = availableEngines().filter((e) => e.available).map((e) => e.label);
  console.log(`\n  \x1b[1mFolio\x1b[0m läuft auf \x1b[36mhttp://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\x1b[0m`);
  console.log(`  Projekte: ${WORKSPACE}`);
  console.log(`  Compiler: ${engines.length ? engines.join(', ') : '\x1b[33mkeiner gefunden – bitte TeX Live oder Tectonic installieren\x1b[0m'}\n`);
});
