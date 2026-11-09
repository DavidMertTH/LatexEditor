export type TreeNode = { type: 'file' | 'dir'; name: string; path: string; children?: TreeNode[] };

export type Project = {
  id: string;
  name: string;
  path: string;
  mainFile: string;
  modified: number;
  inWorkspace: boolean;
  hasPdf: boolean;
};

export type Engine = { id: string; label: string; available: boolean };

export type Settings = { mainFile: string; engine: string; autoCompile: boolean };

export type ProjectDetail = Project & { settings: Settings; tree: TreeNode[]; engines: Engine[] };

export type LogEntry = { level: 'error' | 'warning' | 'typesetting'; file: string | null; line: number | null; message: string; content: string };

export type CompileResult = {
  status: 'success' | 'partial' | 'failure' | 'error' | 'cancelled';
  message?: string;
  errors: LogEntry[];
  warnings: LogEntry[];
  typesetting: LogEntry[];
  log: string;
  pdf?: string | null;
  pdfVersion?: number | null;
  durationMs?: number;
  engine?: string;
};

export type ProjectIndex = {
  files: string[];
  labels: { label: string; file: string; line: number; context: string }[];
  bib: { key: string; type: string; title: string; author: string; year: string; file: string }[];
  commands: { name: string; args: number; file: string }[];
  environments: { name: string; file: string }[];
  packages: string[];
};

export type Info = {
  workspace: string;
  home: string;
  engines: Engine[];
  templates: { id: string; name: string; description: string }[];
};

export type GitStatus = {
  available: boolean;
  repo: boolean;
  remote?: string | null;
  url?: string | null;
  web?: string | null;
  branch?: string | null;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  dirty?: number;
  lastCommit?: { hash: string; time: number; message: string } | null;
  busy?: boolean;
};

export type GitPrefer = 'mine' | 'remote';
export type GitResult = { status: GitStatus; pulled?: string[]; pushed?: boolean; committed?: boolean; conflict?: boolean };

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw Object.assign(new Error((body && body.error) || `Fehler ${res.status}`), { status: res.status });
  return body as T;
}

const json = (method: string, data: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(data),
});

const enc = encodeURIComponent;

export const api = {
  info: () => req<Info>('/api/info'),
  projects: () => req<Project[]>('/api/projects'),
  createProject: (name: string, template: string) => req<Project>('/api/projects', json('POST', { name, template })),
  openFolder: (path: string) => req<Project>('/api/projects/open', json('POST', { path })),
  removeProject: (id: string, trash: boolean) => req(`/api/projects/${id}?trash=${trash ? 1 : 0}`, { method: 'DELETE' }),
  browse: (path?: string) => req<{ path: string; parent: string | null; dirs: string[]; texCount: number }>(`/api/browse${path ? `?path=${enc(path)}` : ''}`),

  project: (id: string) => req<ProjectDetail>(`/api/p/${id}`),
  tree: (id: string) => req<TreeNode[]>(`/api/p/${id}/tree`),
  saveSettings: (id: string, s: Partial<Settings>) => req<Settings>(`/api/p/${id}/settings`, json('PUT', s)),
  readFile: (id: string, path: string) => req<{ content: string; mtime: number }>(`/api/p/${id}/file?path=${enc(path)}`),
  writeFile: (id: string, path: string, content: string) =>
    req<{ ok: boolean }>(`/api/p/${id}/file?path=${enc(path)}`, { method: 'PUT', headers: { 'content-type': 'text/plain; charset=utf-8' }, body: content }),
  upload: (id: string, path: string, data: Blob, opts: { exclusive?: boolean } = {}) =>
    req(`/api/p/${id}/upload?path=${enc(path)}${opts.exclusive ? '&exclusive=1' : ''}`, {
      method: 'POST',
      // ohne Content-Type (z. B. .eps/.cls unter Windows) ignoriert der Server den Body
      headers: { 'content-type': data.type || 'application/octet-stream' },
      body: data,
    }),
  fs: (id: string, op: 'mkdir' | 'create' | 'rename' | 'delete', path: string, extra: Record<string, unknown> = {}) =>
    req<{ ok: boolean; tree: TreeNode[] }>(`/api/p/${id}/fs`, json('POST', { op, path, ...extra })),
  index: (id: string) => req<ProjectIndex>(`/api/p/${id}/index`),
  compile: (id: string) => req<CompileResult>(`/api/p/${id}/compile`, { method: 'POST' }),
  cancel: (id: string) => req(`/api/p/${id}/compile/cancel`, { method: 'POST' }),
  forward: (id: string, file: string, line: number) =>
    req<{ page: number; rects: { x: number; y: number; w: number; h: number }[]; line: number } | null>(`/api/p/${id}/synctex/forward?file=${enc(file)}&line=${line}`),
  inverse: (id: string, page: number, x: number, y: number) =>
    req<{ file: string; line: number } | null>(`/api/p/${id}/synctex/inverse?page=${page}&x=${x}&y=${y}`),
  gitStatus: (id: string) => req<GitStatus>(`/api/p/${id}/git`),
  gitPull: (id: string, prefer?: GitPrefer) => req<GitResult>(`/api/p/${id}/git/pull`, json('POST', { prefer })),
  gitSync: (id: string, message?: string, prefer?: GitPrefer) => req<GitResult>(`/api/p/${id}/git/sync`, json('POST', { message, prefer })),
  gitLink: (id: string, url: string) => req<GitResult>(`/api/p/${id}/git/link`, json('POST', { url })),
  rawUrl: (id: string, path: string) => `/api/p/${id}/raw/${path.split('/').map(enc).join('/')}`,
  outputUrl: (id: string, file: string, v?: number | null, download = false) =>
    `/api/p/${id}/output/${enc(file)}?v=${v ?? Date.now()}${download ? '&download=1' : ''}`,
};
