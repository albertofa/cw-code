import {
  Children,
  createContext,
  isValidElement,
  memo,
  useContext,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { renderToStaticMarkup } from "react-dom/server";
import { useNotifs } from "./Notifications.js";
import {
  Check,
  ExternalLink,
  FileCode,
  Info,
  Lightbulb,
  MessageSquareWarning,
  OctagonAlert,
  TriangleAlert,
  WrapText,
  type LucideIcon
} from "lucide-react";
import { GitHubMark } from "./GitHubMark.js";
import { FileIcon } from "./fileIcons.js";
import { shortenHome } from "./pathDisplay.js";
import { useAppStore } from "../stores/appStore.js";
import { isHttpsLink } from "./releaseNotes.js";
import { parseFilePath, type FileRef } from "./markdownPaths.js";
import { parseAlertMarker, type AlertKind } from "./markdownAlerts.js";

const PREVIEW_EXTS = new Set(["md", "markdown", "html", "htm"]);
const HTML_EXTS = new Set(["html", "htm"]);

export function isPreviewablePath(path: string): boolean {
  const clean = path.split("#")[0].split("?")[0];
  const dot = clean.lastIndexOf(".");
  if (dot < 0) return false;
  return PREVIEW_EXTS.has(clean.slice(dot + 1).toLowerCase());
}

export function isHtmlPath(path: string): boolean {
  const clean = path.split("#")[0].split("?")[0];
  const dot = clean.lastIndexOf(".");
  if (dot < 0) return false;
  return HTML_EXTS.has(clean.slice(dot + 1).toLowerCase());
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

const BlockCodeContext = createContext(false);
const InLinkContext = createContext(false);

function codeLanguage(children: ReactNode): string | null {
  for (const child of Children.toArray(children)) {
    if (!isValidElement<{ className?: string }>(child)) continue;
    const match = /language-([\w+#.-]+)/.exec(child.props.className ?? "");
    if (match) return match[1];
  }
  return null;
}

function Pre({ children }: { children?: ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const [wrapped, setWrapped] = useState(false);
  const language = codeLanguage(children);

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
    <BlockCodeContext.Provider value={true}>
      <div className={wrapped ? "md-pre md-pre-wrapped" : "md-pre"}>
        <div className="md-pre-head">
          <FileCode aria-hidden="true" size={14} />
          {language && <span className="md-pre-lang">{language}</span>}
          <div className="md-pre-actions">
            <button
              type="button"
              className="md-pre-btn"
              aria-pressed={wrapped}
              aria-label="Wrap long lines"
              title={wrapped ? "Stop wrapping lines" : "Wrap long lines"}
              onClick={() => setWrapped((value) => !value)}
            >
              <WrapText aria-hidden="true" size={14} />
            </button>
            <button type="button" className="md-copy" onClick={copy} title="Copy code">
              {copied ? <Check aria-hidden="true" size={14} /> : "Copy"}
            </button>
          </div>
        </div>
        <pre ref={preRef}>{children}</pre>
      </div>
    </BlockCodeContext.Provider>
  );
}

export function isHttpLink(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

export function isGitHubLink(href: string): boolean {
  if (!isHttpLink(href)) return false;
  try {
    const host = new URL(href).hostname.toLowerCase();
    return host === "github.com" || host === "www.github.com" || host === "gist.github.com";
  } catch {
    return false;
  }
}

function HtmlFileChip({
  href,
  label,
  onOpenFile,
  onOpenExternal
}: {
  href: string;
  label?: ReactNode;
  onOpenFile?: (path: string) => void;
  onOpenExternal?: (path: string) => void;
}) {
  const homeDir = useAppStore((s) => s.homeDir) ?? undefined;
  const onClick = (e: ReactMouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (onOpenFile) {
      onOpenFile(href);
      return;
    }
    if (!navigator.clipboard) return;
    void navigator.clipboard
      .writeText(href)
      .then(() => useNotifs.getState().push({ kind: "info", title: "Link copied", message: href }))
      .catch(() => {});
  };
  const shown = typeof label === "string" ? shortenHome(label, homeDir) : (label ?? shortenHome(href, homeDir));

  return (
    <span className="md-link-html">
      <a className="md-link-html-body" href={href} onClick={onClick} title={href}>
        <FileIcon name={href} size={13} />
        {shown}
      </a>
      {onOpenExternal && (
        <button
          type="button"
          className="md-link-html-browser"
          title="Open in browser"
          aria-label="Open in browser"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onOpenExternal(href);
          }}
        >
          <ExternalLink size={12} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

function MdLink({
  href,
  children,
  onOpenFile,
  onOpenExternal
}: {
  href?: string;
  children?: ReactNode;
  onOpenFile?: (path: string) => void;
  onOpenExternal?: (path: string) => void;
}) {
  const github = !!href && isGitHubLink(href);
  const onClick = (e: ReactMouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    if (!href) return;
    if (onOpenFile && isLocalPreviewLink(href)) {
      onOpenFile(href);
      return;
    }
    if (isHttpLink(href)) {
      void window.cw.openExternal(href).catch(() => {
        useNotifs.getState().push({ kind: "error", title: "Could not open link", message: href });
      });
      return;
    }
    if (!navigator.clipboard) return;
    void navigator.clipboard
      .writeText(href)
      .then(() => useNotifs.getState().push({ kind: "info", title: "Link copied", message: href }))
      .catch(() => {});
  };

  if (href && isLocalPreviewLink(href) && isHtmlPath(href)) {
    return <HtmlFileChip href={href} label={children} onOpenFile={onOpenFile} onOpenExternal={onOpenExternal} />;
  }

  return (
    <a href={href} onClick={onClick} title={href} className={github ? "md-link-gh" : undefined}>
      {github && <GitHubMark size={12} />}
      <InLinkContext.Provider value={true}>{children}</InLinkContext.Provider>
    </a>
  );
}

function reactText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(reactText).join("");
  return "";
}

function fileBaseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function lineLabel({ line, endLine }: FileRef): string {
  if (line === undefined) return "";
  return endLine === undefined ? `:${line}` : `:${line}-${endLine}`;
}

function SourceChip({
  fileRef,
  onOpenSource
}: {
  fileRef: FileRef;
  onOpenSource: (path: string, line?: number) => void;
}) {
  const name = fileBaseName(fileRef.path);
  const label = lineLabel(fileRef);
  return (
    <button
      type="button"
      className="md-file-chip"
      title={`${fileRef.path}${label}`}
      onClick={(e) => {
        e.stopPropagation();
        onOpenSource(fileRef.path, fileRef.line);
      }}
    >
      <FileIcon name={name} size={13} />
      <span className="md-file-chip-name">{name}</span>
      {label && <span className="md-file-chip-line">{label}</span>}
    </button>
  );
}

function MdCode({
  children,
  className,
  onOpenFile,
  onOpenSource,
  onOpenExternal
}: {
  children?: ReactNode;
  className?: string;
  onOpenFile?: (path: string) => void;
  onOpenSource?: (path: string, line?: number) => void;
  onOpenExternal?: (path: string) => void;
}) {
  const inBlock = useContext(BlockCodeContext);
  const inLink = useContext(InLinkContext);
  const text = reactText(children).trim();
  if (!inBlock && text.length > 0 && !/\s/.test(text) && isLocalPreviewLink(text) && isHtmlPath(text)) {
    return <HtmlFileChip href={text} label={text} onOpenFile={onOpenFile} onOpenExternal={onOpenExternal} />;
  }
  const fileRef = !inBlock && !inLink && onOpenSource ? parseFilePath(text) : null;
  if (fileRef && onOpenSource) return <SourceChip fileRef={fileRef} onOpenSource={onOpenSource} />;
  return <code className={className}>{children}</code>;
}

function MdTable({ children }: { children?: ReactNode }) {
  return (
    <div className="md-table-wrap">
      <table>{children}</table>
    </div>
  );
}

const ALERTS: Record<AlertKind, { label: string; Icon: LucideIcon }> = {
  note: { label: "Note", Icon: Info },
  tip: { label: "Tip", Icon: Lightbulb },
  important: { label: "Important", Icon: MessageSquareWarning },
  warning: { label: "Warning", Icon: TriangleAlert },
  caution: { label: "Caution", Icon: OctagonAlert }
};

interface AlertContent {
  kind: AlertKind;
  body: ReactNode[];
}

function extractAlert(children: ReactNode): AlertContent | null {
  const nodes = Children.toArray(children);
  const firstIndex = nodes.findIndex((node) => isValidElement(node));
  const first = nodes[firstIndex];
  if (!isValidElement<{ children?: ReactNode }>(first) || first.type !== "p") return null;
  const inline = Children.toArray(first.props.children);
  const head = inline[0];
  if (typeof head !== "string") return null;
  const newline = head.indexOf("\n");
  const marker = parseAlertMarker(newline < 0 ? head : head.slice(0, newline));
  if (!marker) return null;
  const tail = newline < 0 ? "" : head.slice(newline + 1);
  const firstText = [marker.rest, tail].filter(Boolean).join("\n");
  const firstParagraph = [...(firstText ? [firstText] : []), ...inline.slice(1)];
  const rest = nodes.slice(firstIndex + 1);
  return {
    kind: marker.kind,
    body: firstParagraph.length > 0 ? [<p key="alert-first">{firstParagraph}</p>, ...rest] : rest
  };
}

function MdBlockquote({ children }: { children?: ReactNode }) {
  const alert = extractAlert(children);
  if (!alert) return <blockquote>{children}</blockquote>;
  const { label, Icon } = ALERTS[alert.kind];
  return (
    <div className={`md-alert ${alert.kind}`}>
      <div className="md-alert-head">
        <Icon aria-hidden="true" size={14} />
        {label}
      </div>
      {alert.body}
    </div>
  );
}

export function sanitizeStreamingMarkdown(text: string): string {
  const fences = text.split("\n").filter((line) => line.trimStart().startsWith("```")).length;
  if (fences % 2 === 1) return `${text}\n\`\`\``;
  return text;
}

function MdImageLink({ src, alt }: { src?: string; alt?: string }) {
  const label = alt?.trim() || src || "image";
  const insideLink = useContext(InLinkContext);
  if (!src || insideLink) return <span className="md-image-link">{label}</span>;
  return (
    <span className="md-image-link">
      <MdLink href={src}>{label}</MdLink>
    </span>
  );
}

function HttpsOnlyLink({ href, children }: { href?: string; children?: ReactNode }) {
  if (!href || !isHttpsLink(href)) return <span>{children}</span>;
  return <MdLink href={href}>{children}</MdLink>;
}

function HttpsOnlyImage({ src, alt }: { src?: string; alt?: string }) {
  const label = alt?.trim() || src || "image";
  const insideLink = useContext(InLinkContext);
  return <span className="md-image-link">{src && !insideLink ? <HttpsOnlyLink href={src}>{label}</HttpsOnlyLink> : label}</span>;
}

const HTTPS_ONLY_COMPONENTS: Components = {
  pre: Pre,
  table: MdTable,
  blockquote: MdBlockquote,
  a: ({ href, children }) => <HttpsOnlyLink href={href}>{children}</HttpsOnlyLink>,
  img: ({ src, alt }) => <HttpsOnlyImage src={typeof src === "string" ? src : undefined} alt={alt} />
};

export const Md = memo(function Md({
  text,
  onOpenFile,
  onOpenSource,
  onOpenExternal,
  allowImages = true,
  linkPolicy = "default"
}: {
  text: string;
  onOpenFile?: (path: string) => void;
  onOpenSource?: (path: string, line?: number) => void;
  onOpenExternal?: (path: string) => void;
  allowImages?: boolean;
  linkPolicy?: "default" | "https-only";
}) {
  const components = useMemo<Components>(
    () =>
      linkPolicy === "https-only"
        ? HTTPS_ONLY_COMPONENTS
        : {
            pre: Pre,
            code: (props) => (
              <MdCode {...props} onOpenFile={onOpenFile} onOpenSource={onOpenSource} onOpenExternal={onOpenExternal} />
            ),
            table: MdTable,
            blockquote: MdBlockquote,
            a: (props) => <MdLink {...props} onOpenFile={onOpenFile} onOpenExternal={onOpenExternal} />,
            ...(allowImages ? {} : { img: ({ src, alt }) => <MdImageLink src={typeof src === "string" ? src : undefined} alt={alt} /> })
          },
    [onOpenFile, onOpenSource, onOpenExternal, allowImages, linkPolicy]
  );
  return (
    <div className="md">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </div>
  );
});

export const StreamingMd = memo(function StreamingMd({
  text,
  onOpenFile,
  onOpenSource,
  onOpenExternal
}: {
  text: string;
  onOpenFile?: (path: string) => void;
  onOpenSource?: (path: string, line?: number) => void;
  onOpenExternal?: (path: string) => void;
}) {
  const components = useMemo<Components>(
    () => ({
      pre: Pre,
      code: (props) => (
        <MdCode {...props} onOpenFile={onOpenFile} onOpenSource={onOpenSource} onOpenExternal={onOpenExternal} />
      ),
      table: MdTable,
      blockquote: MdBlockquote,
      a: (props) => <MdLink {...props} onOpenFile={onOpenFile} onOpenExternal={onOpenExternal} />
    }),
    [onOpenFile, onOpenSource, onOpenExternal]
  );
  const sanitized = useMemo(() => sanitizeStreamingMarkdown(text), [text]);
  return (
    <div className="md md-streaming">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {sanitized}
      </Markdown>
    </div>
  );
});
