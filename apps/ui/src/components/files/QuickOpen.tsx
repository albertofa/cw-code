import { useEffect, useMemo, useRef, useState } from "react";
import { FileIcon } from "../fileIcons.js";
import { ipcErrorMessage } from "../ipcError.js";
import { rankFiles } from "../../files/fuzzy.js";
import { HighlightedPositions } from "./HighlightedText.js";

const RESULT_LIMIT = 60;
const LIST_CACHE_MS = 15_000;

const listCache = new Map<string, { at: number; files: string[] }>();

function parseQuery(raw: string): { text: string; line: number | null } {
  const match = /^(.*?):(\d+)(?::\d+)?$/.exec(raw.trim());
  if (!match) return { text: raw.trim(), line: null };
  return { text: match[1].trim(), line: Number(match[2]) };
}

function splitPath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? { name: path, dir: "" } : { name: path.slice(slash + 1), dir: path.slice(0, slash) };
}

export function QuickOpen({
  sessionId,
  initialQuery,
  recent,
  onOpen,
  onClose
}: {
  sessionId: string;
  initialQuery: string;
  recent: string[];
  onOpen: (path: string, line: number | null) => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [raw, setRaw] = useState(initialQuery);
  const [files, setFiles] = useState<string[] | null>(() => listCache.get(sessionId)?.files ?? null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    inputRef.current?.focus();
    const cached = listCache.get(sessionId);
    if (cached && Date.now() - cached.at < LIST_CACHE_MS) return;
    let cancelled = false;
    window.cw
      .listWorkspaceFiles(sessionId)
      .then((list) => {
        listCache.set(sessionId, { at: Date.now(), files: list });
        if (!cancelled) setFiles(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(ipcErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const { text, line } = parseQuery(raw);

  const results = useMemo(() => {
    if (!text) {
      const known = new Set(files ?? []);
      return recent.filter((path) => files === null || known.has(path)).map((path) => ({ path, positions: [] as number[] }));
    }
    return rankFiles(text, files ?? [], RESULT_LIMIT);
  }, [text, files, recent]);

  useEffect(() => setSelected(0), [text]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const choose = (index: number) => {
    const result = results[index];
    if (!result) return;
    onOpen(result.path, line);
  };

  return (
    <div className="fx-quick-backdrop" onPointerDown={onClose}>
      <div className="fx-quick" role="dialog" aria-label="Go to file" onPointerDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="fx-input fx-quick-input"
          value={raw}
          placeholder="Search files by name (append :line to jump)"
          spellCheck={false}
          aria-label="File name"
          aria-controls="fx-quick-list"
          aria-activedescendant={results[selected] ? `fx-quick-${selected}` : undefined}
          onChange={(e) => setRaw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelected((value) => Math.min(results.length - 1, value + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelected((value) => Math.max(0, value - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(selected);
            }
          }}
        />
        <div ref={listRef} id="fx-quick-list" className="fx-quick-list" role="listbox">
          {error && <div className="fx-quick-empty">Couldn’t list files: {error}</div>}
          {!error && files === null && text && <div className="fx-quick-empty">Indexing files…</div>}
          {!error && files !== null && results.length === 0 && (
            <div className="fx-quick-empty">{text ? "No matching files." : "Type to search files."}</div>
          )}
          {!text && results.length > 0 && <div className="fx-quick-section">Open editors</div>}
          {results.map((result, index) => {
            const { name, dir } = splitPath(result.path);
            const nameOffset = result.path.length - name.length;
            return (
              <div
                key={result.path}
                id={`fx-quick-${index}`}
                data-index={index}
                role="option"
                aria-selected={index === selected}
                className={`fx-quick-row${index === selected ? " selected" : ""}`}
                onMouseMove={() => setSelected(index)}
                onClick={() => choose(index)}
              >
                <FileIcon name={name} size={15} />
                <span className="fx-quick-name">
                  <HighlightedPositions text={name} positions={result.positions} offset={nameOffset} />
                </span>
                <span className="fx-quick-dir">
                  <HighlightedPositions text={dir} positions={result.positions} />
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function invalidateQuickOpenCache(sessionId: string): void {
  listCache.delete(sessionId);
}
