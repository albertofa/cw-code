import { Compartment, RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import { syntaxHighlighting } from "@codemirror/language";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { lezerHighlightStyle } from "./lezerStyle.js";
import { highlightWithShiki, type ShikiTokens } from "./shikiClient.js";

export const SHIKI_MAX_CHARS = 500_000;
const EDIT_DEBOUNCE_MS = 180;

export const lezerColors = new Compartment();

const setShikiDecorations = StateEffect.define<DecorationSet>();

const shikiDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, tr) {
    for (const effect of tr.effects) if (effect.is(setShikiDecorations)) return effect.value;
    return tr.docChanged ? decorations.map(tr.changes) : decorations;
  },
  provide: (field) => EditorView.decorations.from(field)
});

const markCache = new Map<string, Decoration>();

function markFor(style: string): Decoration {
  let mark = markCache.get(style);
  if (!mark) {
    mark = Decoration.mark({ attributes: { style } });
    markCache.set(style, mark);
  }
  return mark;
}

function buildDecorations(tokens: ShikiTokens, docLength: number): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { spans, styles } = tokens;
  for (let i = 0; i + 2 < spans.length; i += 3) {
    const from = spans[i];
    const to = Math.min(spans[i + 1], docLength);
    if (to <= from) continue;
    builder.add(from, to, markFor(styles[spans[i + 2]]));
  }
  return builder.finish();
}

export function shikiHighlighting(lang: string, owner: string): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | null = null;
      private version = 0;
      private destroyed = false;

      constructor(private readonly view: EditorView) {
        if (view.state.field(shikiDecorations).size === 0) this.schedule(0);
      }

      update(update: ViewUpdate): void {
        if (!update.docChanged) return;
        this.version += 1;
        this.schedule(EDIT_DEBOUNCE_MS);
      }

      destroy(): void {
        this.destroyed = true;
        if (this.timer) clearTimeout(this.timer);
      }

      private schedule(delay: number): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.run(), delay);
      }

      private async run(): Promise<void> {
        this.timer = null;
        const version = this.version;
        const doc = this.view.state.doc;
        if (doc.length > SHIKI_MAX_CHARS) {
          if (this.view.state.field(shikiDecorations).size > 0) {
            this.view.dispatch({
              effects: [setShikiDecorations.of(Decoration.none), lezerColors.reconfigure(syntaxHighlighting(lezerHighlightStyle))]
            });
          }
          return;
        }
        const tokens = await highlightWithShiki(owner, lang, doc.sliceString(0, doc.length, "\n"));
        if (this.destroyed || !tokens || version !== this.version) return;
        this.view.dispatch({
          effects: [setShikiDecorations.of(buildDecorations(tokens, this.view.state.doc.length)), lezerColors.reconfigure([])]
        });
      }
    }
  );
  return [shikiDecorations, plugin];
}
