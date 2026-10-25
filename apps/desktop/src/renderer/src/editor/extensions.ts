import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { gotoLine, highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  type ViewUpdate
} from "@codemirror/view";
import { detectEol, detectIndent, type Eol } from "../files/textFormat.js";
import { editorTheme } from "./editorTheme.js";
import { gitGutter } from "./gitGutter.js";
import { resolveLanguage, type ResolvedLanguage } from "./languages.js";
import { lezerHighlightStyle } from "./lezerStyle.js";
import { lezerColors, shikiHighlighting } from "./shikiHighlight.js";
import { SHIKI_MAX_CHARS } from "./shikiProtocol.js";

export interface EditorHost {
  save(): void;
  update(update: ViewUpdate): void;
}

const hosts = new WeakMap<EditorView, EditorHost>();

export function attachHost(view: EditorView, host: EditorHost): void {
  hosts.set(view, host);
}

export const languageCompartment = new Compartment();
export const readOnlyCompartment = new Compartment();
export const wrapCompartment = new Compartment();

export const setEol = StateEffect.define<Eol>();

export const eolField = StateField.define<Eol>({
  create: () => "\n",
  update: (value, tr) => tr.effects.reduce((current, effect) => (effect.is(setEol) ? effect.value : current), value)
});

export interface DocMeta {
  key: string;
  path: string;
  language: ResolvedLanguage;
  indentLabel: string;
}

export const docMetaField = StateField.define<DocMeta>({
  create: () => ({ key: "", path: "", language: resolveLanguage(""), indentLabel: "Spaces: 2" }),
  update: (value) => value
});

const foldMarker = (open: boolean): HTMLElement => {
  const marker = document.createElement("span");
  marker.className = `cm-fold-marker ${open ? "open" : "closed"}`;
  marker.textContent = open ? "⌄" : "›";
  return marker;
};

const baseExtensions: Extension = [
  lineNumbers(),
  gitGutter,
  highlightActiveLineGutter(),
  foldGutter({ markerDOM: foldMarker }),
  highlightSpecialChars(),
  history(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  EditorView.clickAddsSelectionRange.of((event) => event.altKey),
  rectangularSelection({ eventFilter: (event) => event.altKey && event.shiftKey }),
  indentOnInput(),
  bracketMatching(),
  closeBrackets(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  search({ top: true }),
  keymap.of([
    { key: "Mod-s", preventDefault: true, run: (view) => (hosts.get(view)?.save(), true) },
    { key: "Mod-g", preventDefault: true, run: gotoLine },
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...searchKeymap,
    ...historyKeymap,
    ...foldKeymap,
    indentWithTab
  ]),
  EditorView.updateListener.of((update) => hosts.get(update.view)?.update(update)),
  editorTheme
];

export function createEditorState(key: string, path: string, content: string, opts: { readOnly: boolean; wrap: boolean }): EditorState {
  const language = resolveLanguage(path);
  const indent = detectIndent(content);
  const eol = detectEol(content);
  const shiki = language.shiki && content.length <= SHIKI_MAX_CHARS ? shikiHighlighting(language.shiki, key) : [];
  return EditorState.create({
    doc: content,
    extensions: [
      baseExtensions,
      eolField.init(() => eol),
      docMetaField.init(() => ({ key, path, language, indentLabel: indent.label })),
      indentUnit.of(indent.unit),
      EditorState.tabSize.of(indent.unit === "\t" ? 4 : indent.unit.length),
      languageCompartment.of([]),
      lezerColors.of(syntaxHighlighting(lezerHighlightStyle)),
      shiki,
      readOnlyCompartment.of([EditorState.readOnly.of(opts.readOnly), EditorView.editable.of(!opts.readOnly)]),
      wrapCompartment.of(opts.wrap ? EditorView.lineWrapping : [])
    ]
  });
}

export function readOnlyExtension(readOnly: boolean): Extension {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

export function wrapExtension(wrap: boolean): Extension {
  return wrap ? EditorView.lineWrapping : [];
}

export function docContent(state: EditorState): string {
  return state.doc.sliceString(0, state.doc.length, state.field(eolField));
}

export async function loadStructuralLanguage(view: EditorView): Promise<boolean> {
  const meta = view.state.field(docMetaField);
  const description = meta.language.cm;
  if (!description) return true;
  try {
    const support = description.support ?? (await description.load());
    if (view.state.field(docMetaField).key !== meta.key) return false;
    view.dispatch({ effects: languageCompartment.reconfigure(support) });
    return true;
  } catch (err) {
    console.warn(`[editor] could not load ${description.name} language support: ${(err as Error).message}`);
    return true;
  }
}
