import { useEffect, useLayoutEffect, useRef } from "react";
import { Annotation, EditorSelection, Transaction, type EditorState, type StateEffect } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import type { GitBaseline } from "@cw-code/contracts";
import { detectEol } from "../files/textFormat.js";
import { useEditorBuffers } from "../stores/editorBuffers.js";
import {
  attachHost,
  createEditorState,
  docContent,
  docMetaField,
  eolField,
  loadStructuralLanguage,
  setEol,
  readOnlyCompartment,
  readOnlyExtension,
  wrapCompartment,
  wrapExtension
} from "./extensions.js";
import { gitBaselineField, setGitBaseline } from "./gitGutter.js";

export interface EditorStatus {
  line: number;
  column: number;
  selected: number;
  cursors: number;
  indentLabel: string;
  eol: "LF" | "CRLF";
  language: string;
}

export interface EditorReveal {
  line: number;
  column?: number;
  length?: number;
  text?: string;
  nonce: number;
}

const states = new Map<string, EditorState>();
const scrolls = new Map<string, StateEffect<unknown>>();
const synced = new Map<string, string>();
const structured = new Set<string>();
const appliedReveals = new Map<string, number>();
const fromStore = Annotation.define<boolean>();

export function disposeEditorState(key: string): void {
  states.delete(key);
  scrolls.delete(key);
  synced.delete(key);
  structured.delete(key);
  appliedReveals.delete(key);
}

function cacheState(key: string, view: EditorView): void {
  if (!useEditorBuffers.getState().buffers[key]) return;
  states.set(key, view.state);
  scrolls.set(key, view.scrollSnapshot());
}

function statusOf(state: EditorState): EditorStatus {
  const main = state.selection.main;
  const line = state.doc.lineAt(main.head);
  const meta = state.field(docMetaField);
  return {
    line: line.number,
    column: main.head - line.from + 1,
    selected: state.selection.ranges.reduce((total, range) => total + range.to - range.from, 0),
    cursors: state.selection.ranges.length,
    indentLabel: meta.indentLabel,
    eol: state.field(eolField) === "\r\n" ? "CRLF" : "LF",
    language: meta.language.label
  };
}

function findInLine(lineText: string, text: string): number {
  const exact = lineText.indexOf(text);
  return exact >= 0 ? exact : lineText.toLowerCase().indexOf(text.toLowerCase());
}

function replaceFromStore(view: EditorView, key: string, content: string): void {
  synced.set(key, content);
  const eol = detectEol(content);
  if (eol !== view.state.field(eolField)) view.dispatch({ effects: setEol.of(eol) });
  const next = content.replace(/\r\n?/g, "\n");
  const current = view.state.doc.toString();
  if (next === current) return;
  let start = 0;
  const max = Math.min(next.length, current.length);
  while (start < max && next.charCodeAt(start) === current.charCodeAt(start)) start++;
  let endCurrent = current.length;
  let endNext = next.length;
  while (endCurrent > start && endNext > start && next.charCodeAt(endNext - 1) === current.charCodeAt(endCurrent - 1)) {
    endCurrent--;
    endNext--;
  }
  view.dispatch({
    changes: { from: start, to: endCurrent, insert: next.slice(start, endNext) },
    annotations: [fromStore.of(true), Transaction.addToHistory.of(false)]
  });
}

export function CodeEditor({
  bufferKey,
  path,
  readOnly,
  wrap,
  reveal,
  baseline,
  onSave,
  onStatus
}: {
  bufferKey: string;
  path: string;
  readOnly: boolean;
  wrap: boolean;
  reveal: EditorReveal | null;
  baseline: GitBaseline | null;
  onSave: () => void;
  onStatus: (status: EditorStatus) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const keyRef = useRef<string | null>(null);
  const callbacks = useRef({ onSave, onStatus });
  callbacks.current = { onSave, onStatus };

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({ parent: host });
    viewRef.current = view;
    attachHost(view, {
      save: () => callbacks.current.onSave(),
      update: (update: ViewUpdate) => {
        const key = update.state.field(docMetaField).key;
        if (update.docChanged && !update.transactions.some((tr) => tr.annotation(fromStore))) {
          const content = docContent(update.state);
          synced.set(key, content);
          useEditorBuffers.getState().update(key, content);
        }
        if (update.docChanged || update.selectionSet) callbacks.current.onStatus(statusOf(update.state));
      }
    });
    return () => {
      const key = keyRef.current;
      if (key) cacheState(key, view);
      view.destroy();
      viewRef.current = null;
      keyRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view || keyRef.current === bufferKey) return;
    const previous = keyRef.current;
    if (previous) cacheState(previous, view);
    const content = useEditorBuffers.getState().buffers[bufferKey]?.content ?? "";
    let state = states.get(bufferKey);
    if (!state || state.field(docMetaField).path !== path) {
      state = createEditorState(bufferKey, path, content, { readOnly, wrap });
      synced.set(bufferKey, content);
      scrolls.delete(bufferKey);
      structured.delete(bufferKey);
    }
    keyRef.current = bufferKey;
    view.setState(state);
    const scroll = scrolls.get(bufferKey);
    if (scroll) view.dispatch({ effects: scroll });
    if (content !== synced.get(bufferKey)) replaceFromStore(view, bufferKey, content);
    if (!structured.has(bufferKey)) {
      structured.add(bufferKey);
      void loadStructuralLanguage(view).then((applied) => {
        if (!applied) structured.delete(bufferKey);
      });
    }
    callbacks.current.onStatus(statusOf(view.state));
  }, [bufferKey, path, readOnly, wrap]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: [readOnlyCompartment.reconfigure(readOnlyExtension(readOnly)), wrapCompartment.reconfigure(wrapExtension(wrap))]
    });
  }, [readOnly, wrap, bufferKey]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.field(gitBaselineField).source === baseline) return;
    view.dispatch({ effects: setGitBaseline.of(baseline) });
  }, [baseline, bufferKey]);

  useEffect(
    () =>
      useEditorBuffers.subscribe((store) => {
        const view = viewRef.current;
        const key = keyRef.current;
        if (!view || !key) return;
        const buffer = store.buffers[key];
        if (!buffer || buffer.content === synced.get(key)) return;
        replaceFromStore(view, key, buffer.content);
      }),
    []
  );

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !reveal || appliedReveals.get(bufferKey) === reveal.nonce) return;
    appliedReveals.set(bufferKey, reveal.nonce);
    const doc = view.state.doc;
    const line = doc.line(Math.min(Math.max(1, reveal.line), doc.lines));
    const found = reveal.text ? findInLine(line.text, reveal.text) : -1;
    const from = found >= 0 ? line.from + found : Math.min(line.from + Math.max(0, (reveal.column ?? 1) - 1), line.to);
    const to = Math.min(from + Math.max(0, found >= 0 ? (reveal.text?.length ?? 0) : (reveal.length ?? 0)), line.to);
    view.dispatch({
      selection: EditorSelection.single(from, to),
      effects: EditorView.scrollIntoView(from, { y: "center" })
    });
    view.focus();
  }, [reveal?.nonce, bufferKey]);

  return <div ref={hostRef} className="code-editor" />;
}
