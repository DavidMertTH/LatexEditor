import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseLog } from './logparser.js';
import { exists } from './util.js';

export const OUT_DIR = '.latex-out';

function which(bin) {
  // A binary in ./bin (e.g. a downloaded tectonic) takes precedence over $PATH.
  const dirs = [path.resolve(import.meta.dirname, '..', 'bin'), ...(process.env.PATH || '').split(path.delimiter)];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

let toolCache = null;
export function detectTools(refresh = false) {
  if (toolCache && !refresh) return toolCache;
  const t = {};
  for (const bin of ['latexmk', 'pdflatex', 'xelatex', 'lualatex', 'tectonic', 'bibtex', 'biber']) t[bin] = which(bin);
  toolCache = t;
  return t;
}

export function availableEngines() {
  const t = detectTools();
  return [
    { id: 'pdflatex', label: 'pdfLaTeX', available: !!t.pdflatex },
    { id: 'xelatex', label: 'XeLaTeX', available: !!t.xelatex },
    { id: 'lualatex', label: 'LuaLaTeX', available: !!t.lualatex },
    { id: 'tectonic', label: 'Tectonic', available: !!t.tectonic },
  ];
}

export function defaultEngine() {
  const e = availableEngines().find((x) => x.available);
  return e ? e.id : 'pdflatex';
}

const running = new Map(); // projectRoot -> child process

function run(cmd, args, opts, onOutput) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      ...opts,
      env: {
        ...process.env,
        max_print_line: '10000',
        error_line: '254',
        half_error_line: '238',
        ...(opts.env || {}),
      },
    });
    running.set(opts.cwd, child);
    let out = '';
    const onData = (d) => {
      out += d.toString();
      onOutput?.(d.toString());
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeout ?? 180000);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, out: out + `\n${err.message}`, killed: false });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (running.get(opts.cwd) === child) running.delete(opts.cwd);
      resolve({ code, out, killed: signal === 'SIGTERM' || signal === 'SIGKILL' });
    });
  });
}

export function cancelCompile(root) {
  const child = running.get(root);
  if (child) {
    child.kill('SIGTERM');
    running.delete(root);
    return true;
  }
  return false;
}

/**
 * Compile `mainFile` inside `root`. Output (pdf, log, synctex) goes into `root/.latex-out`.
 */
export async function compile(root, { mainFile, engine }) {
  cancelCompile(root);
  const tools = detectTools();
  const outDir = path.join(root, OUT_DIR);
  await fs.mkdir(outDir, { recursive: true });
  const mainAbs = path.join(root, mainFile);
  if (!(await exists(mainAbs))) {
    return { status: 'error', message: `Hauptdatei „${mainFile}“ nicht gefunden.`, errors: [], warnings: [], typesetting: [], log: '' };
  }
  const jobBase = path.basename(mainFile, path.extname(mainFile));
  const mainDir = path.dirname(mainFile);
  const started = Date.now();
  let output = '';
  let res;

  if (engine === 'tectonic') {
    if (!tools.tectonic) return missingEngine(engine);
    res = await run(
      tools.tectonic,
      ['-X', 'compile', mainFile, '--synctex', '--keep-logs', '--keep-intermediates', '--outdir', OUT_DIR, '--untrusted'],
      { cwd: root },
    );
    output += res.out;
  } else if (tools.latexmk) {
    const flag = { pdflatex: '-pdf', xelatex: '-xelatex', lualatex: '-lualatex' }[engine] || '-pdf';
    res = await run(
      tools.latexmk,
      [flag, '-f', '-g', '-synctex=1', '-interaction=nonstopmode', '-file-line-error', '-no-shell-escape', `-outdir=${OUT_DIR}`, mainFile],
      { cwd: root },
    );
    output += res.out;
  } else {
    const bin = tools[engine];
    if (!bin) return missingEngine(engine);
    const args = ['-synctex=1', '-interaction=nonstopmode', '-file-line-error', '-no-shell-escape', `-output-directory=${OUT_DIR}`, mainFile];
    res = await run(bin, args, { cwd: root });
    output += res.out;
    // Bibliography pass if needed
    const aux = await fs.readFile(path.join(outDir, jobBase + '.aux'), 'utf8').catch(() => '');
    const bcf = await exists(path.join(outDir, jobBase + '.bcf'));
    let ranBib = false;
    if (bcf && tools.biber) {
      const b = await run(tools.biber, ['--input-directory', mainDir || '.', '--output-directory', OUT_DIR, jobBase], { cwd: root });
      output += '\n' + b.out;
      ranBib = true;
    } else if (/\\bibdata\{/.test(aux) && tools.bibtex) {
      const b = await run(tools.bibtex, [jobBase], { cwd: outDir, env: { BIBINPUTS: `${root}:`, BSTINPUTS: `${root}:` } });
      output += '\n' + b.out;
      ranBib = true;
    }
    const needsRerun = (log) => /Rerun to get|Label\(s\) may have changed|Please rerun|No file [^\n]*\.(toc|lof|lot)/i.test(log);
    for (let i = 0; i < 3 && !res.killed; i++) {
      const log = await fs.readFile(path.join(outDir, jobBase + '.log'), 'utf8').catch(() => '');
      if (!ranBib && !needsRerun(log)) break;
      ranBib = false;
      res = await run(bin, args, { cwd: root });
      output += res.out;
    }
  }

  if (res.killed) {
    return { status: 'cancelled', errors: [], warnings: [], typesetting: [], log: output, durationMs: Date.now() - started };
  }

  const logText = await fs.readFile(path.join(outDir, jobBase + '.log'), 'utf8').catch(() => '');
  const parsed = parseLog(logText || output, root);
  if (engine === 'tectonic' && !logText) {
    // tectonic prints "error: file.tex:12: message" on stderr if no log was written
    for (const m of output.matchAll(/^error: (?:(.+?):(\d+): )?(.+)$/gm)) {
      parsed.errors.push({ level: 'error', file: m[1] ? normalizeFile(m[1], root) : null, line: m[2] ? +m[2] : null, message: m[3], content: '' });
    }
  }
  const pdfPath = path.join(outDir, jobBase + '.pdf');
  let pdfStat = null;
  try {
    pdfStat = await fs.stat(pdfPath);
  } catch {}
  const freshPdf = pdfStat && pdfStat.mtimeMs >= started - 1000;

  return {
    status: freshPdf ? (parsed.errors.length ? 'partial' : 'success') : 'failure',
    errors: parsed.errors,
    warnings: parsed.warnings,
    typesetting: parsed.typesetting,
    log: (logText || '') + (logText ? '\n\n──── Prozessausgabe ────\n' : '') + output,
    pdf: freshPdf || pdfStat ? `${jobBase}.pdf` : null,
    pdfVersion: pdfStat ? Math.round(pdfStat.mtimeMs) : null,
    durationMs: Date.now() - started,
  };
}

function normalizeFile(f, root) {
  let p = f.replace(/^\.\//, '');
  if (path.isAbsolute(p)) p = path.relative(root, p);
  return p;
}

function missingEngine(engine) {
  return {
    status: 'error',
    message: `Kein LaTeX-Compiler für „${engine}“ gefunden. Installiere z. B. TeX Live (sudo pacman -S texlive-basic texlive-latex texlive-latexrecommended texlive-latexextra texlive-fontsrecommended texlive-langgerman texlive-binextra) oder Tectonic (sudo pacman -S tectonic).`,
    errors: [],
    warnings: [],
    typesetting: [],
    log: '',
  };
}
