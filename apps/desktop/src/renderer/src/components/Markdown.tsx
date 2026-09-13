import { memo, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { renderToStaticMarkup } from "react-dom/server";
import { useNotifs } from "./Notifications.js";
import { Check } from "lucide-react";

const PREVIEW_EXTS = new Set(["md", "markdown", "html", "htm"]);

export function isPreviewablePath(path: string): boolean {
  const clean = path.split("#")[0].split("?")[0];
  const dot = clean.lastIndexOf(".");
  if (dot < 0) return false;
  return PREVIEW_EXTS.has(clean.slice(dot + 1).toLowerCase());
}

export function isLocalPreviewLink(href: string): boolean {
  const clean = href.split("#")[0].split("?")[0];
  if (!clean || clean.startsWith("//")) return false;
  if (/^[a-zA-Z]:[\\/]/.test(clean)) return isPreviewablePath(clean);
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(clean)) return false;
  return isPreviewablePath(clean);
}

export interface PreviewPaths {
  rel: string;
  abs: string;
}

export function isPathInsideBase(basePath: string, absPath: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const base = norm(basePath);
  if (!base) return false;
  const p = norm(absPath);
  return p === base || p.startsWith(`${base}/`);
}

export function isAbsolutePath(path: string): boolean {
  return /^[a-zA-Z]:\//.test(path.replace(/\\/g, "/")) || path.startsWith("/");
}

export function resolvePreviewPaths(basePath: string, path: string): PreviewPaths {
  const norm = (s: string) => s.replace(/\\/g, "/");
  const base = norm(basePath).replace(/\/+$/, "");
  const p = norm(path);
  const isAbs = /^[a-zA-Z]:\//.test(p) || p.startsWith("/");
  if (isAbs) {
    if (base && p.toLowerCase().startsWith(`${base.toLowerCase()}/`)) {
      return { rel: p.slice(base.length + 1), abs: p };
    }
    return { rel: p, abs: p };
  }
  return { rel: p.replace(/^\/+/, ""), abs: base ? `${base}/${p.replace(/^\/+/, "")}` : p };
}

const PREVIEW_CSS = [
  "body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.65;",
  "color:#1f2328;background:#ffffff;max-width:860px;margin:0 auto;padding:32px 24px;}",
  "pre{background:#f6f8fa;border:1px solid #d0d7de;border-radius:8px;padding:12px;overflow-x:auto;}",
  "code{font-family:ui-monospace,Consolas,monospace;font-size:13px;}",
  "p code,li code{background:#eff1f3;border-radius:4px;padding:1px 5px;}",
  "table{border-collapse:collapse;}th,td{border:1px solid #d0d7de;padding:6px 12px;}",
  "blockquote{border-left:3px solid #d0d7de;margin:12px 0;padding:2px 0 2px 14px;color:#59636e;}",
  "img{max-width:100%;}a{color:#0969da;}"
].join("");

export function buildPreviewHtml(title: string, markdown: string): string {
  const body = renderToStaticMarkup(
    <Markdown remarkPlugins={[remarkGfm]}>{markdown}</Markdown>
  );
  const safeTitle = title.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] ?? c);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title><style>${PREVIEW_CSS}</style></head><body>${body}</body></html>`;
}

function Pre({ children }: { children?: ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  const copy = () => {
    const text = preRef.current?.querySelector("code")?.textContent ?? preRef.current?.textContent ?? "";
    if (!text || !navigator.clipboard) return;
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  return (
    <div className="md-pre">
      <button className="md-copy" onClick={copy} title="Copy code">
        {copied ? <Check aria-hidden="true" size={14} /> : "Copy"}
      </button>
      <pre ref={preRef}>{children}</pre>
    </div>
  );
}

function MdLink({
  href,
  children,
  onOpenFile
}: {
  href?: string;
  children?: ReactNode;
  onOpenFile?: (path: string) => void;
}) {
  const onClick = (e: ReactMouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    if (!href) return;
    if (onOpenFile && isLocalPreviewLink(href)) {
      onOpenFile(href);
      return;
    }
    if (!navigator.clipboard) return;
    void navigator.clipboard
      .writeText(href)
      .then(() => useNotifs.getState().push({ kind: "info", title: "Link copied", message: href }))
      .catch(() => {});
  };

  return (
    <a href={href} onClick={onClick} title={href}>
      {children}
    </a>
  );
}

function MdTable({ children }: { children?: ReactNode }) {
  return (
    <div className="md-table-wrap">
      <table>{children}</table>
    </div>
  );
}

export const Md = memo(function Md({ text, onOpenFile }: { text: string; onOpenFile?: (path: string) => void }) {
  const components = useMemo<Components>(
    () => ({
      pre: Pre,
      table: MdTable,
      a: (props) => <MdLink {...props} onOpenFile={onOpenFile} />
    }),
    [onOpenFile]
  );
  return (
    <div className="md">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </div>
  );
});
