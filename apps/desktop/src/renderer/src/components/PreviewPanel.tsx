import { useEffect, useState } from "react";
import { ExternalLink, X } from "lucide-react";
import { FileIcon } from "./fileIcons.js";
import { Md, buildPreviewHtml, isAbsolutePath, isPathInsideBase, resolvePreviewPaths } from "./Markdown.js";

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

export function PreviewPanel({
  sessionId,
  path,
  basePath,
  onClose
}: {
  sessionId: string;
  path: string;
  basePath: string;
  onClose: () => void;
}) {
  const { rel, abs } = resolvePreviewPaths(basePath, path);
  const name = baseName(rel) || rel;
  const isHtml = /\.(html?|htm)$/i.test(rel);
  const outside = !isPathInsideBase(basePath, abs);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [externalError, setExternalError] = useState<string | null>(null);

  useEffect(() => {
    setContent(null);
    setError(null);
    if (outside && !isAbsolutePath(abs)) {
      setError(`cannot resolve outside the project: ${path}`);
      return;
    }
    const load = outside ? window.cw.readOutsideFile(abs) : window.cw.readFile(sessionId, rel);
    load.then(setContent).catch((err: Error) => setError(err.message));
  }, [sessionId, rel, abs, outside, path]);

  const openExternal = () => {
    setExternalError(null);
    if (isHtml) {
      window.cw.openPath(abs).catch((err: Error) => setExternalError(err.message));
    } else if (content != null) {
      window.cw
        .openHtml(name, buildPreviewHtml(name, content))
        .catch((err: Error) => setExternalError(err.message));
    }
  };

  return (
    <div className="preview-panel">
      <div className="preview-head">
        <FileIcon name={name} size={14} />
        <span className="preview-name" title={path}>
          {name}
        </span>
        <button className="icon-btn" onClick={openExternal} title="Open in browser" aria-label="Open in browser">
          <ExternalLink size={14} />
        </button>
        <button className="icon-btn" onClick={onClose} title="Close preview" aria-label="Close preview">
          <X size={14} />
        </button>
      </div>
      {(error ?? externalError) && <div className="preview-error">{error ?? externalError}</div>}
      {content == null && !error ? (
        <div className="preview-loading">loading…</div>
      ) : content != null ? (
        isHtml ? (
          <iframe className="preview-frame" title={name} sandbox="" srcDoc={content} />
        ) : (
          <div className="preview-body">
            <Md text={content} />
          </div>
        )
      ) : null}
    </div>
  );
}
