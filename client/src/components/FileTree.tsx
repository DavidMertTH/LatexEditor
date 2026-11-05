import { useState, type ReactNode } from 'react';
import { ChevronRight, Folder, FileText, FileImage, BookOpen, File, MoreHorizontal, Pencil, Trash2, Star, FilePlus, FolderPlus, FileCode } from 'lucide-react';
import type { TreeNode } from '../api';
import { Menu, Popover, usePersistentState, type MenuEntry } from '../ui';

export function fileIcon(name: string, size = 15): ReactNode {
  const ext = name.split('.').pop()?.toLowerCase();
  if (ext === 'tex') return <FileText size={size} style={{ color: 'var(--accent-fg)' }} />;
  if (ext === 'bib') return <BookOpen size={size} style={{ color: 'var(--syn-env)' }} />;
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'pdf', 'eps', 'webp'].includes(ext ?? '')) return <FileImage size={size} style={{ color: 'var(--green)' }} />;
  if (['sty', 'cls', 'bst'].includes(ext ?? '')) return <FileCode size={size} style={{ color: 'var(--orange)' }} />;
  return <File size={size} style={{ color: 'var(--dim)' }} />;
}

interface Props {
  tree: TreeNode[];
  active: string | null;
  mainFile: string;
  projectId: string;
  onOpen: (path: string) => void;
  onRename: (from: string, to: string) => void;
  onDelete: (path: string) => void;
  onSetMain: (path: string) => void;
  onNewFile: (dir: string) => void;
  onNewFolder: (dir: string) => void;
  onUpload: (dir: string, files: FileList) => void;
  onMove: (from: string, toDir: string) => void;
}

export function FileTree(props: Props) {
  const [expanded, setExpanded] = usePersistentState<Record<string, boolean>>(`folio.tree.${props.projectId}`, {});
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ anchor: DOMRect; node: TreeNode } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const toggle = (p: string) => setExpanded((e) => ({ ...e, [p]: !e[p] }));

  const menuItems = (node: TreeNode): MenuEntry[] => {
    const dir = node.type === 'dir' ? node.path : node.path.split('/').slice(0, -1).join('/');
    const items: MenuEntry[] = [];
    if (node.type === 'file' && node.name.endsWith('.tex') && node.path !== props.mainFile) {
      items.push({ label: 'Als Hauptdatei festlegen', icon: <Star size={14} />, onClick: () => props.onSetMain(node.path) });
      items.push('sep');
    }
    items.push(
      { label: 'Neue Datei …', icon: <FilePlus size={14} />, onClick: () => props.onNewFile(dir) },
      { label: 'Neuer Ordner …', icon: <FolderPlus size={14} />, onClick: () => props.onNewFolder(dir) },
      'sep',
      { label: 'Umbenennen', icon: <Pencil size={14} />, onClick: () => setRenaming(node.path) },
      { label: 'In den Papierkorb', icon: <Trash2 size={14} />, danger: true, onClick: () => props.onDelete(node.path) },
    );
    return items;
  };

  const onDrop = (e: React.DragEvent, dir: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    const moved = e.dataTransfer.getData('application/x-folio-path');
    if (moved) {
      if (moved !== dir && !dir.startsWith(moved + '/')) props.onMove(moved, dir);
      return;
    }
    if (e.dataTransfer.files.length) props.onUpload(dir, e.dataTransfer.files);
  };

  const render = (nodes: TreeNode[], depth: number): ReactNode =>
    nodes.map((node) => {
      const isDir = node.type === 'dir';
      const open = !!expanded[node.path];
      const pad = 8 + depth * 14;
      return (
        <div key={node.path}>
          <div
            className={`tree-row ${props.active === node.path ? 'active' : ''} ${dropTarget === node.path ? 'drop' : ''}`}
            style={{ paddingLeft: pad }}
            draggable={renaming !== node.path}
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-folio-path', node.path);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => {
              if (!isDir) return;
              e.preventDefault();
              e.stopPropagation();
              setDropTarget(node.path);
            }}
            onDragLeave={() => setDropTarget((t) => (t === node.path ? null : t))}
            onDrop={(e) => isDir && onDrop(e, node.path)}
            onClick={() => (isDir ? toggle(node.path) : props.onOpen(node.path))}
            onDoubleClick={() => !isDir && setRenaming(node.path)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ anchor: new DOMRect(e.clientX, e.clientY, 0, 0), node });
            }}
          >
            <span className={`chev ${open ? 'open' : ''}`} style={{ visibility: isDir ? 'visible' : 'hidden' }}>
              <ChevronRight size={13} />
            </span>
            {isDir ? <Folder size={15} style={{ color: 'var(--muted)' }} fill="currentColor" fillOpacity={0.15} /> : fileIcon(node.name)}
            {renaming === node.path ? (
              <RenameInput
                initial={node.name}
                onDone={(name) => {
                  setRenaming(null);
                  if (name && name !== node.name) {
                    const parent = node.path.split('/').slice(0, -1).join('/');
                    props.onRename(node.path, parent ? `${parent}/${name}` : name);
                  }
                }}
              />
            ) : (
              <span className="name">{node.name}</span>
            )}
            {node.path === props.mainFile && <span className="badge">Haupt</span>}
            <button
              className="icon-btn sm row-more"
              onClick={(e) => {
                e.stopPropagation();
                setMenu({ anchor: e.currentTarget.getBoundingClientRect(), node });
              }}
            >
              <MoreHorizontal size={14} />
            </button>
          </div>
          {isDir && open && render(node.children ?? [], depth + 1)}
        </div>
      );
    });

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDropTarget('');
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDropTarget(null);
      }}
      onDrop={(e) => onDrop(e, '')}
      style={{ minHeight: '100%', borderRadius: 8, outline: dropTarget === '' ? '2px dashed var(--accent)' : 'none', outlineOffset: -2 }}
    >
      {render(props.tree, 0)}
      {menu && (
        <Popover anchor={menu.anchor} onClose={() => setMenu(null)}>
          <Menu items={menuItems(menu.node)} onClose={() => setMenu(null)} />
        </Popover>
      )}
    </div>
  );
}

function RenameInput({ initial, onDone: done }: { initial: string; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(initial);
  const [finished, setFinished] = useState(false);
  const onDone = (value: string | null) => {
    if (finished) return;
    setFinished(true);
    done(value);
  };
  return (
    <input
      autoFocus
      value={v}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setV(e.target.value)}
      onFocus={(e) => {
        const dot = initial.lastIndexOf('.');
        e.currentTarget.setSelectionRange(0, dot > 0 ? dot : initial.length);
      }}
      onBlur={() => onDone(v.trim() || null)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onDone(v.trim() || null);
        if (e.key === 'Escape') onDone(null);
      }}
    />
  );
}
