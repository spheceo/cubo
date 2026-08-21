import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type MouseEvent,
  type SetStateAction,
} from 'react';
import { IoAdd, IoChevronForward, IoFolder, IoFolderOpen } from 'react-icons/io5';
import { Dropdown } from '@/components/dropdown';
import {
  createFolder,
  listFolders,
  type FolderInfo,
  type LocalEngineConnection,
} from '@/lib/local-engine';

interface TreeNode extends FolderInfo {
  children?: TreeNode[];
  open?: boolean;
  loading?: boolean;
}

/** Browse folders on the Core machine. Core never returns file names — only
 *  child folders plus whether a folder already contains files. One folder is
 *  active at a time; new folders are created inside that one. */
export function FolderPicker({
  connection,
  currentDirectory,
  onCancel,
  onSelect,
}: {
  connection: LocalEngineConnection;
  currentDirectory: string;
  onCancel: () => void;
  onSelect: (path: string) => void;
}) {
  const [roots, setRoots] = useState<TreeNode[]>([]);
  const [activePath, setActivePath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loadingRoots, setLoadingRoots] = useState(true);
  const [naming, setNaming] = useState(false);
  const [newName, setNewName] = useState('Cubo Cache');
  const [creating, setCreating] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingRoots(true);
    void listFolders(connection)
      .then((listing) => {
        if (cancelled) return;
        setRoots(listing.folders);
        setActivePath((current) => current || listing.folders[0]?.path || '');
      })
      .catch(() => {
        if (!cancelled) setError('Could not read folders on this Core.');
      })
      .finally(() => {
        if (!cancelled) setLoadingRoots(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connection]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      if (menu) {
        setMenu(null);
        return;
      }
      if (naming) {
        setNaming(false);
        return;
      }
      onCancel();
    };
    const closeMenu = () => setMenu(null);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('click', closeMenu);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('click', closeMenu);
    };
  }, [menu, naming, onCancel]);

  const loadedFolders = useMemo(() => flattenNodes(roots), [roots]);
  const active = loadedFolders.find((folder) => folder.path === activePath) ?? null;

  const activate = useCallback((path: string) => {
    setActivePath(path);
    setError(null);
    setMenu(null);
  }, []);

  const toggle = useCallback(
    async (node: TreeNode) => {
      if (!node.hasFolders || node.loading) return;
      if (node.open) {
        updateNode(setRoots, node.path, (current) => ({ ...current, open: false }));
        return;
      }
      if (node.children) {
        updateNode(setRoots, node.path, (current) => ({ ...current, open: true }));
        return;
      }
      updateNode(setRoots, node.path, (current) => ({ ...current, loading: true }));
      try {
        const listing = await listFolders(connection, node.path);
        updateNode(setRoots, node.path, (current) => ({
          ...current,
          open: true,
          loading: false,
          children: listing.folders,
        }));
      } catch {
        updateNode(setRoots, node.path, (current) => ({ ...current, loading: false }));
        setError('Could not open that folder.');
      }
    },
    [connection],
  );

  const startCreate = useCallback((path?: string) => {
    if (path) setActivePath(path);
    setNewName('Cubo Cache');
    setNaming(true);
    setMenu(null);
    setError(null);
  }, []);

  const submitCreate = useCallback(async () => {
    const parent = activePath;
    const name = newName.trim();
    if (!parent || !name || creating) return;
    setCreating(true);
    setError(null);
    try {
      const created = await createFolder(connection, parent, name);
      const listing = await listFolders(connection, parent);
      updateNode(setRoots, parent, (current) => ({
        ...current,
        open: true,
        loading: false,
        hasFolders: true,
        children: listing.folders,
      }));
      setActivePath(created.path);
      setNaming(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create that folder.');
    } finally {
      setCreating(false);
    }
  }, [activePath, connection, creating, newName]);

  const usable = active && !active.hasFiles && active.path !== currentDirectory;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 px-6 backdrop-blur-sm"
      onClick={onCancel}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Choose a cache folder"
        className="flex w-full max-w-lg flex-col rounded-2xl bg-panel p-6 text-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 className="text-xl font-semibold">Choose a cache folder</h3>
        <p className="mt-2 text-sm leading-6 text-white/60">
          One folder is active at a time. Create a new empty folder inside it, or pick an empty one.
        </p>

        <div className="mt-4 flex items-center gap-2">
          <Dropdown
            value={activePath}
            options={loadedFolders.map((folder) => ({
              value: folder.path,
              label: folder.path,
            }))}
            onChange={activate}
            disabled={loadedFolders.length === 0}
            ariaLabel="Active folder"
            className="min-w-0 flex-1"
          />
          <button
            type="button"
            disabled={!activePath || creating}
            onClick={() => startCreate()}
            className="inline-flex shrink-0 cursor-pointer items-center gap-2 rounded-full bg-control px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-control-hover disabled:cursor-default disabled:opacity-35"
          >
            <IoAdd size={16} />
            New folder
          </button>
        </div>

        {naming ? (
          <form
            className="mt-3 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void submitCreate();
            }}
          >
            <input
              autoFocus
              type="text"
              value={newName}
              disabled={creating}
              aria-label="New folder name"
              onChange={(event) => setNewName(event.target.value)}
              className="min-w-0 flex-1 rounded-full bg-control px-4 py-2 text-sm text-white outline-none focus:bg-control-hover"
            />
            <button
              type="submit"
              disabled={creating || !newName.trim()}
              className="shrink-0 cursor-pointer rounded-full bg-white px-4 py-2 text-sm font-semibold text-black disabled:cursor-default disabled:opacity-35"
            >
              Create
            </button>
          </form>
        ) : null}

        <div className="mt-4 max-h-72 overflow-y-auto rounded-2xl bg-control/60 py-2">
          {loadingRoots ? (
            <p className="px-4 py-6 text-sm text-faint">Reading folders…</p>
          ) : roots.length === 0 ? (
            <p className="px-4 py-6 text-sm text-faint">No folders were found.</p>
          ) : (
            <FolderList
              nodes={roots}
              depth={0}
              activePath={activePath}
              onToggle={(node) => void toggle(node)}
              onActivate={activate}
              onCreate={startCreate}
              onMenu={(event, path) => {
                event.preventDefault();
                activate(path);
                setMenu({ x: event.clientX, y: event.clientY, path });
              }}
            />
          )}
        </div>

        <p className="mt-3 truncate text-sm text-faint">{active ? active.path : 'No folder selected'}</p>
        {error ? <p className="mt-2 text-sm text-white/70">{error}</p> : null}
        {active?.hasFiles ? (
          <p className="mt-2 text-sm text-white/70">
            That folder already has files. Create an empty folder inside it, or pick another.
          </p>
        ) : null}

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="cursor-pointer rounded-full bg-white/10 px-5 py-2 font-semibold transition-colors hover:bg-white/15"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!usable}
            onClick={() => {
              if (usable && active) onSelect(active.path);
            }}
            className="cursor-pointer rounded-full bg-white px-5 py-2 font-semibold text-black transition-colors hover:bg-white/85 disabled:cursor-default disabled:opacity-35"
          >
            Use this folder
          </button>
        </div>
      </div>

      {menu ? (
        <div
          role="menu"
          className="fixed z-[70] min-w-40 rounded-xl border border-line bg-panel py-1 shadow-2xl"
          style={{ left: menu.x, top: menu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => startCreate(menu.path)}
            className="flex w-full cursor-pointer items-center gap-2 px-4 py-2 text-left text-sm text-white hover:bg-control"
          >
            <IoAdd size={15} />
            New folder
          </button>
        </div>
      ) : null}
    </div>
  );
}

function FolderList({
  nodes,
  depth,
  activePath,
  onToggle,
  onActivate,
  onCreate,
  onMenu,
}: {
  nodes: TreeNode[];
  depth: number;
  activePath: string;
  onToggle: (node: TreeNode) => void;
  onActivate: (path: string) => void;
  onCreate: (path: string) => void;
  onMenu: (event: MouseEvent, path: string) => void;
}) {
  return (
    <ul className="m-0 list-none p-0">
      {nodes.map((node) => (
        <li key={node.path}>
          <div
            className={`flex items-center gap-1 px-2 py-1 ${
              activePath === node.path ? 'bg-white/10' : ''
            }`}
            style={{ paddingLeft: 12 + depth * 16 }}
            onContextMenu={(event) => onMenu(event, node.path)}
          >
            <button
              type="button"
              disabled={!node.hasFolders}
              aria-label={node.open ? `Collapse ${node.name}` : `Expand ${node.name}`}
              onClick={() => onToggle(node)}
              className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-white/50 disabled:cursor-default disabled:opacity-20"
            >
              <IoChevronForward
                size={14}
                className={`transition-transform ${node.open ? 'rotate-90' : ''}`}
              />
            </button>
            <button
              type="button"
              onClick={() => onActivate(node.path)}
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-full px-2 py-1 text-left text-sm hover:bg-white/5"
            >
              {node.open ? (
                <IoFolderOpen size={16} className="shrink-0 text-white/50" />
              ) : (
                <IoFolder size={16} className="shrink-0 text-white/50" />
              )}
              <span className="truncate">{node.name}</span>
              {node.hasFiles ? <span className="shrink-0 text-xs text-faint">has files</span> : null}
              {node.loading ? <span className="shrink-0 text-xs text-faint">…</span> : null}
            </button>
          </div>
          {node.open && node.children ? (
            <FolderList
              nodes={node.children}
              depth={depth + 1}
              activePath={activePath}
              onToggle={onToggle}
              onActivate={onActivate}
              onCreate={onCreate}
              onMenu={onMenu}
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function flattenNodes(nodes: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (items: TreeNode[]) => {
    for (const node of items) {
      out.push(node);
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

function updateNode(
  setRoots: Dispatch<SetStateAction<TreeNode[]>>,
  path: string,
  update: (node: TreeNode) => TreeNode,
) {
  const rewrite = (nodes: TreeNode[]): TreeNode[] =>
    nodes.map((node) => {
      if (node.path === path) return update(node);
      if (!node.children) return node;
      return { ...node, children: rewrite(node.children) };
    });
  setRoots((nodes) => rewrite(nodes));
}
