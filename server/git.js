// Git/GitHub sync for a project folder: auto-detect repos, pull, commit & push.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0', // never hang on a username/password prompt in the console
  LC_ALL: 'C',
  LANG: 'C',
};

// files the editor creates that must never end up in the repo
const EXCLUDES = ['.latex-out/', '.trash/'];

function run(root, args, { timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: root, env: ENV, timeout, windowsHide: true, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || err?.message || '').trim(),
        missing: err?.code === 'ENOENT',
      });
    });
  });
}

async function git(root, args, opts) {
  const r = await run(root, args, opts);
  if (r.code !== 0) throw gitError(r.stderr || r.stdout || `git ${args[0]} fehlgeschlagen`);
  return r.stdout;
}

function gitError(raw) {
  let msg = raw.split('\n').filter((l) => l && !l.startsWith('hint:')).slice(-3).join(' ').trim();
  if (/Please tell me who you are|unable to auto-detect email/i.test(raw))
    msg = 'Git-Benutzer nicht eingerichtet. Bitte im Terminal ausführen: git config --global user.name "Name" und git config --global user.email "mail@beispiel.de"';
  else if (/Authentication failed|could not read Username|Permission denied|403|terminal prompts disabled/i.test(raw))
    msg = 'Anmeldung bei GitHub fehlgeschlagen. Melde dich einmal über die Kommandozeile an (z. B. „git push“ oder „gh auth login“), danach klappt es automatisch.';
  else if (/Could not resolve host|unable to access|Connection timed out|Network is unreachable/i.test(raw)) msg = 'GitHub nicht erreichbar – keine Internetverbindung?';
  else if (/Repository not found|does not appear to be a git repository/i.test(raw)) msg = 'Repository nicht gefunden – stimmt die URL und hast du Zugriff?';
  return Object.assign(new Error(msg), { status: 409 });
}

// one git operation per repository at a time
const locks = new Map();
function locked(root, fn) {
  const prev = locks.get(root) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(root, next.catch(() => {}));
  return next;
}

let gitAvailable = null;
async function hasGit() {
  if (gitAvailable === null) gitAvailable = !(await run(process.cwd(), ['--version'])).missing;
  return gitAvailable;
}

/** Turn a remote URL into the matching web page (GitHub, GitLab, …). */
export function webUrl(url) {
  if (!url) return null;
  let m = /^git@([^:]+):(.+?)(\.git)?\/?$/.exec(url) || /^ssh:\/\/git@([^/:]+)(?::\d+)?\/(.+?)(\.git)?\/?$/.exec(url);
  if (m) return `https://${m[1]}/${m[2]}`;
  m = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(\.git)?\/?$/.exec(url);
  if (m) return `https://${m[1]}/${m[2]}`;
  return null;
}

async function isRepo(root) {
  const top = await run(root, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return false;
  // a folder that the surrounding repo ignores (e.g. Folio's own projects/ dir) is not "in" that repo
  const ignored = await run(root, ['check-ignore', '-q', '.']);
  return ignored.code !== 0;
}

async function remoteName(root) {
  const remotes = (await run(root, ['remote'])).stdout.split('\n').filter(Boolean);
  return remotes.includes('origin') ? 'origin' : remotes[0] || null;
}

async function currentBranch(root) {
  const r = await run(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
  return r.code === 0 ? r.stdout : null;
}

async function upstream(root) {
  const r = await run(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  return r.code === 0 ? r.stdout : null;
}

async function head(root) {
  const r = await run(root, ['rev-parse', '-q', '--verify', 'HEAD']);
  return r.code === 0 ? r.stdout : null;
}

async function aheadBehind(root) {
  const r = await run(root, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
  if (r.code !== 0) return { ahead: 0, behind: 0 };
  const [a, b] = r.stdout.split(/\s+/).map(Number);
  return { ahead: a || 0, behind: b || 0 };
}

async function dirtyFiles(root) {
  const r = await run(root, ['status', '--porcelain', '--untracked-files=all', '--', '.']);
  return r.code === 0 ? r.stdout.split('\n').filter(Boolean).length : 0;
}

async function ensureExcludes(root) {
  const rel = (await run(root, ['rev-parse', '--git-path', 'info/exclude'])).stdout;
  if (!rel) return;
  const file = path.resolve(root, rel);
  const current = await fs.readFile(file, 'utf8').catch(() => '');
  const missing = EXCLUDES.filter((e) => !current.split(/\r?\n/).includes(e));
  if (!missing.length) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, (current && !current.endsWith('\n') ? '\n' : '') + '# Folio\n' + missing.join('\n') + '\n');
}

/** If the branch has no upstream yet but the remote has a branch with the same name, track it. */
async function ensureUpstream(root, remote, branch) {
  if (!branch || !remote || (await upstream(root))) return;
  const exists = await run(root, ['rev-parse', '-q', '--verify', `refs/remotes/${remote}/${branch}`]);
  if (exists.code === 0) await run(root, ['branch', `--set-upstream-to=${remote}/${branch}`]);
}

function stamp() {
  return new Date().toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Stage everything in the project folder and commit it. Returns true if a commit was made. */
async function commitAll(root, message) {
  await git(root, ['add', '-A', '--', '.']);
  const staged = await run(root, ['diff', '--cached', '--quiet']);
  if (staged.code === 0) return false;
  await git(root, ['commit', '-q', '-m', message || `Folio: Änderungen vom ${stamp()}`]);
  return true;
}

/**
 * Bring remote commits in (rebase local commits on top). On a conflict the rebase is aborted
 * and the repo stays untouched, unless `prefer` says which side wins.
 */
async function integrate(root, prefer) {
  const strategy = prefer === 'mine' ? ['-X', 'theirs'] : prefer === 'remote' ? ['-X', 'ours'] : []; // (sides are swapped during a rebase)
  const r = await run(root, ['rebase', '--autostash', ...strategy, '@{u}']);
  if (r.code === 0) return { conflict: false };
  await run(root, ['rebase', '--abort']);
  return { conflict: true };
}

async function changedBetween(root, a, b) {
  if (!a || !b || a === b) return [];
  const r = await run(root, ['diff', '--name-only', '--relative', a, b]);
  return r.code === 0 ? r.stdout.split('\n').filter(Boolean) : [];
}

export async function status(root) {
  if (!(await hasGit())) return { available: false, repo: false };
  if (!(await isRepo(root))) return { available: true, repo: false };
  const remote = await remoteName(root);
  const url = remote ? (await run(root, ['remote', 'get-url', remote])).stdout : null;
  const branch = await currentBranch(root);
  const up = await upstream(root);
  const { ahead, behind } = up ? await aheadBehind(root) : { ahead: 0, behind: 0 };
  const last = (await run(root, ['log', '-1', '--format=%h%x09%ct%x09%s'])).stdout.split('\t');
  const rebasing = await run(root, ['rev-parse', '-q', '--verify', 'REBASE_HEAD']);
  return {
    available: true,
    repo: true,
    remote,
    url,
    web: webUrl(url),
    branch,
    upstream: up,
    ahead,
    behind,
    dirty: await dirtyFiles(root),
    lastCommit: last[0] ? { hash: last[0], time: Number(last[1]) * 1000, message: last.slice(2).join('\t') } : null,
    busy: rebasing.code === 0,
  };
}

/** Fetch and, if GitHub has new commits, pull them in (committing local edits first). */
export function pull(root, { prefer } = {}) {
  return locked(root, async () => {
    const remote = await remoteName(root);
    if (!remote) throw Object.assign(new Error('Kein GitHub-Repository verknüpft'), { status: 400 });
    const branch = await currentBranch(root);
    if (!branch) throw Object.assign(new Error('Kein Branch ausgecheckt (detached HEAD)'), { status: 409 });
    await git(root, ['fetch', '--quiet', '--prune', remote]);
    await ensureUpstream(root, remote, branch);
    let result = { pulled: [], conflict: false, committed: false };
    if ((await upstream(root)) && (await aheadBehind(root)).behind > 0) {
      await ensureExcludes(root);
      result.committed = await commitAll(root);
      const before = await head(root);
      const { conflict } = await integrate(root, prefer);
      result.conflict = conflict;
      result.pulled = await changedBetween(root, before, await head(root));
    }
    return { ...result, status: await status(root) };
  });
}

/** Commit local changes, pull remote changes, push. */
export function sync(root, { message, prefer } = {}) {
  return locked(root, async () => {
    const remote = await remoteName(root);
    if (!remote) throw Object.assign(new Error('Kein GitHub-Repository verknüpft'), { status: 400 });
    const branch = await currentBranch(root);
    if (!branch) throw Object.assign(new Error('Kein Branch ausgecheckt (detached HEAD)'), { status: 409 });
    await ensureExcludes(root);
    const committed = await commitAll(root, message);
    await git(root, ['fetch', '--quiet', '--prune', remote]);
    await ensureUpstream(root, remote, branch);
    let pulled = [];
    let pushed = false;
    if (await upstream(root)) {
      if ((await aheadBehind(root)).behind > 0) {
        const before = await head(root);
        const { conflict } = await integrate(root, prefer);
        if (conflict) return { committed, pushed, pulled, conflict: true, status: await status(root) };
        pulled = await changedBetween(root, before, await head(root));
      }
      if ((await aheadBehind(root)).ahead > 0) {
        await git(root, ['push', '--quiet'], { timeout: 120000 });
        pushed = true;
      }
    } else if (await head(root)) {
      // first push of this branch
      await git(root, ['push', '--quiet', '-u', remote, branch], { timeout: 120000 });
      pushed = true;
    }
    return { committed, pushed, pulled, conflict: false, status: await status(root) };
  });
}

/** Link a folder to a (GitHub) repository URL: init if needed, set remote, merge existing history, push. */
export function link(root, url) {
  return locked(root, async () => {
    url = String(url || '').trim();
    if (!/^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(url)) throw Object.assign(new Error('Bitte eine Repository-URL angeben, z. B. https://github.com/name/repo'), { status: 400 });
    if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/.test(url) && !url.endsWith('.git')) url = url.replace(/\/$/, '') + '.git';
    if (!(await hasGit())) throw Object.assign(new Error('Git ist nicht installiert'), { status: 400 });

    if (!(await isRepo(root))) await git(root, ['init', '-q', '-b', 'main']);
    await ensureExcludes(root);
    const remote = (await remoteName(root)) || 'origin';
    const hasRemote = (await run(root, ['remote', 'get-url', remote])).code === 0;
    await git(root, ['remote', hasRemote ? 'set-url' : 'add', remote, url]);

    await commitAll(root, 'Projekt mit Folio verknüpft');

    // what's the default branch on the remote (empty repo → none)?
    const ls = await git(root, ['ls-remote', '--symref', remote, 'HEAD'], { timeout: 60000 });
    const remoteBranch = /ref: refs\/heads\/(\S+)\s+HEAD/.exec(ls)?.[1] || null;
    let branch = await currentBranch(root);

    if (remoteBranch) {
      await git(root, ['fetch', '--quiet', remote]);
      if (!(await head(root))) {
        await git(root, ['checkout', '-q', '-b', remoteBranch, '--track', `${remote}/${remoteBranch}`]);
      } else {
        if (branch !== remoteBranch && (await run(root, ['rev-parse', '-q', '--verify', `refs/heads/${remoteBranch}`])).code !== 0) {
          await git(root, ['branch', '-M', remoteBranch]);
          branch = remoteBranch;
        }
        const base = await run(root, ['merge-base', 'HEAD', `${remote}/${remoteBranch}`]);
        if (base.code !== 0) {
          const m = await run(root, ['merge', '--no-edit', '--allow-unrelated-histories', '-m', 'Mit GitHub zusammengeführt', `${remote}/${remoteBranch}`]);
          if (m.code !== 0) {
            await run(root, ['merge', '--abort']);
            throw Object.assign(new Error('Das GitHub-Repository enthält Dateien, die mit lokalen Dateien kollidieren. Bitte manuell zusammenführen.'), { status: 409 });
          }
        }
        await run(root, ['branch', `--set-upstream-to=${remote}/${branch}`]);
      }
    }
    branch = await currentBranch(root);
    if (await head(root)) {
      const up = await upstream(root);
      if (!up) await git(root, ['push', '--quiet', '-u', remote, branch], { timeout: 120000 });
      else if ((await aheadBehind(root)).ahead > 0) await git(root, ['push', '--quiet'], { timeout: 120000 });
    }
    return { status: await status(root) };
  });
}
