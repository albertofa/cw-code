import { EditorView } from "@codemirror/view";

export const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--syn-fg)",
    backgroundColor: "transparent",
    fontSize: "var(--fs-code)"
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--mono)",
    lineHeight: "1.6",
    overscrollBehavior: "contain"
  },
  ".cm-content": { caretColor: "var(--text)", padding: "6px 0" },
  ".cm-line": { padding: "0 16px 0 6px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--syn-selection)"
  },
  ".cm-selectionMatch": { backgroundColor: "var(--syn-selection-match)" },
  ".cm-activeLine": { backgroundColor: "var(--syn-active-line)" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--faint)",
    border: "none",
    fontFamily: "var(--mono)"
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 6px 0 14px", minWidth: "32px" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--dim)" },
  ".cm-git-gutter .cm-gutterElement": { position: "relative", width: "5px", padding: "0 1px 0 0" },
  ".cm-git-marker": { position: "absolute", left: "0", top: "0", bottom: "0", width: "3px" },
  ".cm-git-added": { backgroundColor: "var(--success)" },
  ".cm-git-modified": { backgroundColor: "var(--accent)" },
  ".cm-git-deleted": {
    top: "auto",
    bottom: "-4px",
    width: "0",
    height: "0",
    zIndex: "1",
    borderTop: "4px solid transparent",
    borderBottom: "4px solid transparent",
    borderLeft: "5px solid var(--danger)"
  },
  ".cm-git-deleted.top": { top: "-4px", bottom: "auto" },
  ".cm-foldGutter .cm-gutterElement": {
    color: "transparent",
    cursor: "pointer",
    padding: "0 4px",
    transition: "color 120ms ease"
  },
  ".cm-gutters:hover .cm-foldGutter .cm-gutterElement": { color: "var(--faint)" },
  ".cm-foldGutter .cm-gutterElement:hover": { color: "var(--text)" },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--raised)",
    border: "1px solid var(--border-soft)",
    color: "var(--muted)",
    borderRadius: "4px",
    padding: "0 6px",
    margin: "0 4px"
  },
  "&.cm-focused .cm-matchingBracket": {
    backgroundColor: "var(--syn-bracket)",
    outline: "1px solid var(--syn-bracket-line)"
  },
  "&.cm-focused .cm-nonmatchingBracket": { color: "var(--danger)" },
  ".cm-searchMatch": {
    backgroundColor: "var(--syn-search)",
    outline: "1px solid var(--syn-search-line)"
  },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--syn-search-current)" },
  ".cm-specialChar": { color: "var(--danger)" },
  ".cm-panels": {
    backgroundColor: "var(--overlay)",
    color: "var(--text)",
    fontFamily: "inherit"
  },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border-soft)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border-soft)" },
  ".cm-panel.cm-search": {
    padding: "6px 34px 6px 10px",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "4px 6px",
    fontSize: "var(--t-xs)"
  },
  ".cm-panel.cm-search br": { flexBasis: "100%", height: 0, content: '""' },
  ".cm-panel.cm-search label": {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    color: "var(--muted)",
    fontSize: "var(--t-xs)"
  },
  ".cm-panel.cm-search [name=close]": {
    position: "absolute",
    top: "6px",
    right: "8px",
    color: "var(--muted)",
    fontSize: "16px",
    cursor: "pointer",
    background: "none",
    border: "none"
  },
  ".cm-textfield": {
    backgroundColor: "var(--bg-deep)",
    border: "1px solid var(--border)",
    borderRadius: "var(--r-sm)",
    color: "var(--text)",
    padding: "3px 8px",
    fontSize: "var(--t-xs)",
    fontFamily: "var(--mono)",
    minWidth: "180px",
    margin: 0
  },
  ".cm-textfield:focus": { outline: "none", borderColor: "var(--violet)" },
  ".cm-button": {
    backgroundImage: "none",
    backgroundColor: "transparent",
    border: "1px solid var(--border)",
    borderRadius: "var(--r-sm)",
    color: "var(--dim)",
    padding: "3px 8px",
    fontSize: "var(--t-xs)",
    margin: 0,
    cursor: "pointer"
  },
  ".cm-button:hover": { backgroundColor: "var(--hover)", color: "var(--text)" },
  ".cm-button:active": { backgroundImage: "none", backgroundColor: "var(--raised)" },
  ".cm-tooltip": {
    backgroundColor: "var(--overlay)",
    border: "1px solid var(--border)",
    borderRadius: "var(--r-md)",
    color: "var(--text)"
  },
  ".cm-dialog": { padding: "6px 10px", fontSize: "var(--t-xs)" },
  ".cm-dialog label": { display: "inline-flex", alignItems: "center", gap: "6px", color: "var(--muted)" },
  ".cm-dialog input": {
    backgroundColor: "var(--bg-deep)",
    border: "1px solid var(--border)",
    borderRadius: "var(--r-sm)",
    color: "var(--text)",
    padding: "3px 8px",
    fontFamily: "var(--mono)"
  }
});
