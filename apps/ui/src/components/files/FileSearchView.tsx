import { useEffect, useMemo, useRef, useState } from "react";
import { CaseSensitive, ChevronDown, ChevronRight, Ellipsis, Regex, WholeWord } from "lucide-react";
import type { TextSearchMatch, TextSearchQuery, TextSearchResult } from "@cw-code/contracts";
import { FileIcon } from "../fileIcons.js";
import { ipcErrorMessage } from "../ipcError.js";
import { HighlightedRanges } from "./HighlightedText.js";

const SEARCH_DEBOUNCE_MS = 300;

interface FileGroup {
  path: string;
  matches: TextSearchMatch[];
}

function groupByFile(matches: TextSearchMatch[]): FileGroup[] {
  const groups = new Map<string, TextSearchMatch[]>();
  for (const match of matches) {
    const list = groups.get(match.path);
    if (list) list.push(match);
    else groups.set(match.path, [match]);
  }
  return Array.from(groups, ([path, list]) => ({ path, matches: list }));
}

function splitPath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? { name: path, dir: "" } : { name: path.slice(slash + 1), dir: path.slice(0, slash) };
}

function Toggle({ on, label, onClick, children }: { on: boolean; label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className={`fx-toggle${on ? " on" : ""}`} aria-pressed={on} title={label} aria-label={label} onClick={onClick}>
      {children}
    </button>
  );
}

export interface SearchSeed {
  include: string;
  nonce: number;
}

export function FileSearchView({
  sessionId,
  hidden,
  focusNonce,
  seed,
  onOpenMatch
}: {
  sessionId: string;
  hidden: boolean;
  focusNonce: number;
  seed: SearchSeed | null;
  onOpenMatch: (path: string, line: number, text: string, preview: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [isRegex, setIsRegex] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [result, setResult] = useState<TextSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const seqRef = useRef(0);

  useEffect(() => {
    if (hidden) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusNonce, hidden]);

  useEffect(() => {
    if (!seed) return;
    setInclude(seed.include);
    setShowFilters(true);
    inputRef.current?.focus();
  }, [seed?.nonce]);

  const search: TextSearchQuery = useMemo(
    () => ({ query, matchCase, wholeWord, isRegex, include: include.trim() || undefined, exclude: exclude.trim() || undefined }),
    [query, matchCase, wholeWord, isRegex, include, exclude]
  );

  useEffect(() => {
    const seq = ++seqRef.current;
    if (!search.query) {
      setResult(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      window.cw
        .searchText(sessionId, search)
        .then((next) => {
          if (seqRef.current !== seq) return;
          setResult(next);
          setCollapsed(new Set());
        })
        .catch((err: unknown) => {
          if (seqRef.current !== seq) return;
          setResult({ matches: [], truncated: false, error: ipcErrorMessage(err) });
        })
        .finally(() => {
          if (seqRef.current === seq) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search, sessionId]);

  const groups = useMemo(() => groupByFile(result?.matches ?? []), [result]);
  const total = result?.matches.length ?? 0;

  return (
    <div className="fx-search" hidden={hidden}>
      <div className="fx-search-form">
        <div className="fx-search-field">
          <input
            ref={inputRef}
            className="fx-input"
            value={query}
            placeholder="Search"
            spellCheck={false}
            aria-label="Search in files"
            onChange={(e) => setQuery(e.target.value)}
          />
          <Toggle on={matchCase} label="Match case" onClick={() => setMatchCase((v) => !v)}>
            <CaseSensitive size={15} />
          </Toggle>
          <Toggle on={wholeWord} label="Match whole word" onClick={() => setWholeWord((v) => !v)}>
            <WholeWord size={15} />
          </Toggle>
          <Toggle on={isRegex} label="Use regular expression" onClick={() => setIsRegex((v) => !v)}>
            <Regex size={15} />
          </Toggle>
        </div>
        <button
          type="button"
          className={`fx-filters-btn${showFilters ? " on" : ""}`}
          aria-expanded={showFilters}
          title="Toggle search details"
          onClick={() => setShowFilters((v) => !v)}
        >
          <Ellipsis size={14} />
        </button>
        {showFilters && (
          <div className="fx-search-filters">
            <label>
              <span>files to include</span>
              <input
                className="fx-input"
                value={include}
                placeholder="e.g. *.ts, src/**"
                spellCheck={false}
                onChange={(e) => setInclude(e.target.value)}
              />
            </label>
            <label>
              <span>files to exclude</span>
              <input
                className="fx-input"
                value={exclude}
                placeholder="e.g. *.test.ts, dist"
                spellCheck={false}
                onChange={(e) => setExclude(e.target.value)}
              />
            </label>
          </div>
        )}
      </div>
      <div className="fx-search-summary" aria-live="polite">
        {searching
          ? "Searching…"
          : result?.error
            ? null
            : result
              ? total === 0
                ? "No results."
                : `${total}${result.truncated ? "+" : ""} result${total === 1 ? "" : "s"} in ${groups.length} file${groups.length === 1 ? "" : "s"}${result.truncated ? " (showing the first matches; refine the search)" : ""}`
              : null}
      </div>
      {result?.error && <div className="fx-search-error">{result.error}</div>}
      <div className="fx-search-results">
        {groups.map((group) => {
          const { name, dir } = splitPath(group.path);
          const isCollapsed = collapsed.has(group.path);
          return (
            <div key={group.path} className="fx-search-group">
              <button
                type="button"
                className="fx-search-file"
                title={group.path}
                onClick={() =>
                  setCollapsed((prev) => {
                    const next = new Set(prev);
                    if (next.has(group.path)) next.delete(group.path);
                    else next.add(group.path);
                    return next;
                  })
                }
              >
                <span className="fx-chevron">{isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</span>
                <FileIcon name={name} size={14} />
                <span className="fx-search-name">{name}</span>
                <span className="fx-search-dir">{dir}</span>
                <span className="fx-count">{group.matches.length}</span>
              </button>
              {!isCollapsed &&
                group.matches.map((match, index) => {
                  const first = match.ranges[0];
                  const text = first ? match.preview.slice(first[0], first[1]) : "";
                  return (
                    <button
                      key={`${match.line}:${index}`}
                      type="button"
                      className="fx-search-match"
                      title={`${group.path}:${match.line}`}
                      onClick={(e) => onOpenMatch(match.path, match.line, text, e.detail < 2)}
                      onDoubleClick={() => onOpenMatch(match.path, match.line, text, false)}
                    >
                      <span className="fx-search-line">{match.line}</span>
                      <span className="fx-search-preview">
                        <HighlightedRanges text={match.preview.trimEnd()} ranges={match.ranges} />
                      </span>
                    </button>
                  );
                })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
