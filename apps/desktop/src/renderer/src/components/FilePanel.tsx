import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { FileIcon } from "./fileIcons.js";
import { parseUnifiedDiff } from "./diffParser.js";

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
}

function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", isDir: true, children: [] };
  for (const p of paths) {
    const parts = p.split("/");
    let node = root;
    let prefix = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      prefix = prefix ? `${prefix}/${part}` : part;
      const isDir = i < parts.length - 1;
      let child = node.children.find((c) => c.name === part && c.isDir === isDir);
      if (!child) {
        child = { name: part, path: prefix, isDir, children: [] };
        node.children.push(child);
      }
      node = child;
    }
  }
  const sortRec = (n: TreeNode): void => {
    n.children.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    n.children.forEach(sortRec);
  };
  sortRec(root);
  return root.children;
}

const COLLAPSED_BY_DEFAULT = new Set(["node_modules", "dist", "out", "build", "coverage", ".next", ".git"]);

function chainLeaf(node: TreeNode): { label: string; leaf: TreeNode } {
  let label = node.name;
  let leaf = node;
  while (leaf.isDir && leaf.children.length === 1 && leaf.children[0].isDir) {
    leaf = leaf.children[0];
    label += ` / ${leaf.name}`;
  }
  return { label, leaf };
}

interface TreeViewProps {
  nodes: TreeNode[];
  depth: number;
  openFile: string | null;
  expanded: Set<string>;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
}

function TreeView({ nodes, depth, openFile, expanded, onToggleDir, onOpenFile }: TreeViewProps) {
  return (
    <>
      {nodes.map((n) => {
        if (!n.isDir) {
          return (
            <div
              key={n.path}
              className={`tree-row${n.path === openFile ? " active" : ""}`}
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => onOpenFile(n.path)}
              title={n.path}
            >
              <span className="tree-chevron" />
              <FileIcon name={n.name} size={14} />
              <span className="tree-name">{n.name}</span>
            </div>
          );
        }
        const { label, leaf } = chainLeaf(n);
        const open = expanded.has(n.path);
        return (
          <div key={n.path}>
            <div
              className="tree-row dir"
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => onToggleDir(n.path)}
              title={n.path}
            >
              <span className="tree-chevron">{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
              <FileIcon name={leaf.name} isDir expanded={open} size={14} />
              <span className="tree-name">{label}</span>
            </div>
            {open && (
              <TreeView
                nodes={leaf.children}
                depth={depth + 1}
                openFile={openFile}
                expanded={expanded}
                onToggleDir={onToggleDir}
                onOpenFile={onOpenFile}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

export function FilePanel({ sessionId }: { sessionId: string }) {
  const [files, setFiles] = useState<string[]>([]);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState("");
  const [expanded, setExpanded] = useState<Set<string> | null>(null);

  useEffect(() => {
    setOpenFile(null);
    setContent("");
    setExpanded(null);
    window.cw
      .listFiles(sessionId)
      .then(setFiles)
      .catch((err: Error) => setStatus(`list failed: ${err.message}`));
  }, [sessionId]);

  const tree = useMemo(() => buildTree(files), [files]);

  const defaultExpanded = useMemo(() => {
    const s = new Set<string>();
    const walk = (nodes: TreeNode[]): void => {
      for (const n of nodes) {
        if (n.isDir && !COLLAPSED_BY_DEFAULT.has(n.name)) {
          s.add(n.path);
          walk(n.children);
        }
      }
    };
    walk(tree);
    return s;
  }, [tree]);

  const exp = expanded ?? defaultExpanded;

  const toggleDir = (path: string) => {
    const base = expanded ?? defaultExpanded;
    const next = new Set(base);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setExpanded(next);
  };

  const open = (path: string) => {
    setOpenFile(path);
    window.cw
      .readFile(sessionId, path)
      .then(setContent)
      .catch((err: Error) => setStatus(`read failed: ${err.message}`));
  };

  const save = () => {
    if (!openFile) return;
    window.cw
      .saveFile(sessionId, openFile, content)
      .then(() => setStatus(`saved ${openFile}`))
      .catch((err: Error) => setStatus(`save failed: ${err.message}`));
  };

  const matches = filter
    ? files.filter((f) => f.toLowerCase().includes(filter.toLowerCase())).slice(0, 300)
    : null;

  return (
    <div className="file-layout">
      <div className="file-side">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter files…"
          className="field file-filter"
        />
        <div className="file-list">
          {matches ? (
            matches.map((f) => (
              <div
                key={f}
                onClick={() => open(f)}
                className={`tree-row${f === openFile ? " active" : ""}`}
                title={f}
              >
                <span className="tree-chevron" />
                <FileIcon name={baseName(f)} size={14} />
                <span className="tree-name">{baseName(f)}</span>
              </div>
            ))
          ) : (
            <TreeView
              nodes={tree}
              depth={0}
              openFile={openFile}
              expanded={exp}
              onToggleDir={toggleDir}
              onOpenFile={open}
            />
          )}
          {matches && matches.length === 0 && <div className="side-empty">No matches.</div>}
        </div>
      </div>
      <div className="editor-col">
        <div className="editor-bar">
          <span className="path">{openFile ?? "no file open"}</span>
          {openFile && (
            <button className="btn" style={{ fontSize: 11, padding: "3px 8px" }} onClick={save}>
              Save
            </button>
          )}
          {status && <span className="status">{status}</span>}
        </div>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          spellCheck={false}
          className="editor"
        />
      </div>
    </div>
  );
}

const STATUS_BADGE: Record<string, string> = {
  added: "A",
  deleted: "D",
  renamed: "R",
  modified: "M"
};

export function DiffPanel({ sessionId }: { sessionId: string }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    setDiff(null);
    setCollapsed(new Set());
    window.cw
      .turnDiff(sessionId, Date.now() - 24 * 3600 * 1000)
      .then((d) => setDiff(d))
      .catch((err: Error) => setDiff(`diff unavailable: ${err.message}`));
  }, [sessionId]);

  if (diff == null) return <div className="diff-empty">loading…</div>;
  if (!diff || !diff.includes("diff --git")) {
    return <pre className="diff">{diff || "(clean — no changes)"}</pre>;
  }

  const files = parseUnifiedDiff(diff);
  const totalAdded = files.reduce((n, f) => n + f.added, 0);
  const totalRemoved = files.reduce((n, f) => n + f.removed, 0);

  const toggle = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="diff-list">
      <div className="diff-summary">
        {files.length} file{files.length === 1 ? "" : "s"} · <span className="add">+{totalAdded}</span>{" "}
        <span className="del">−{totalRemoved}</span>
      </div>
      {files.map((f) => {
        const shut = collapsed.has(f.path);
        return (
          <div key={f.path} className="diff-file">
            <div className="diff-head" onClick={() => toggle(f.path)} title={f.path}>
              <span className="tree-chevron">{shut ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</span>
              <FileIcon name={baseName(f.path)} size={14} />
              <span className="diff-path">{f.path}</span>
              <span className={`diff-badge ${f.status}`}>{STATUS_BADGE[f.status]}</span>
              <span className="diff-stats">
                <span className="add">+{f.added}</span> <span className="del">−{f.removed}</span>
              </span>
            </div>
            {!shut && (
              <div className="diff-body">
                {f.lines.map((l, i) => (
                  <div key={i} className={`diff-line ${l.type}`}>
                    <span className="diff-gutter">
                      {l.type === "add" ? "+" : l.type === "del" ? "−" : l.type === "hunk" ? "⋯" : ""}
                    </span>
                    <span className="diff-text">{l.text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
