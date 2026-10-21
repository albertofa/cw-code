import { RangeSet, StateEffect, StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, type ViewUpdate } from "@codemirror/view";
import type { GitBaseline } from "@cw-code/contracts";
import { diffLines, splitLines, type LineChange } from "../files/lineDiff.js";

const DIFF_DEBOUNCE_MS = 200;
const MAX_DIFF_LINES = 50_000;

interface BaselineState {
  source: GitBaseline | null;
  lines: string[] | null;
}

export const setGitBaseline = StateEffect.define<GitBaseline | null>();
const setChangeMarkers = StateEffect.define<RangeSet<GutterMarker>>();

export const gitBaselineField = StateField.define<BaselineState>({
  create: () => ({ source: null, lines: null }),
  update(value, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(setGitBaseline)) continue;
      const source = effect.value;
      return { source, lines: source?.kind === "tracked" ? splitLines(source.content) : null };
    }
    return value;
  }
});

class ChangeMarker extends GutterMarker {
  constructor(private readonly className: string) {
    super();
  }

  eq(other: GutterMarker): boolean {
    return other instanceof ChangeMarker && other.className === this.className;
  }

  toDOM(): Node {
    const marker = document.createElement("span");
    marker.className = this.className;
    return marker;
  }
}

const MARKERS = {
  added: new ChangeMarker("cm-git-marker cm-git-added"),
  modified: new ChangeMarker("cm-git-marker cm-git-modified"),
  deletedBelow: new ChangeMarker("cm-git-marker cm-git-deleted"),
  deletedAbove: new ChangeMarker("cm-git-marker cm-git-deleted top")
};

const changeMarkersField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(markers, tr) {
    for (const effect of tr.effects) if (effect.is(setChangeMarkers)) return effect.value;
    return tr.docChanged ? markers.map(tr.changes) : markers;
  }
});

function docLines(state: EditorState): string[] {
  const out: string[] = [];
  for (const line of state.doc.iterLines()) out.push(line);
  return out;
}

function markersFor(state: EditorState, changes: LineChange[]): RangeSet<GutterMarker> {
  const doc = state.doc;
  const ranges: Range<GutterMarker>[] = [];
  for (const change of changes) {
    if (change.kind === "deleted") {
      if (doc.lines === 0) continue;
      const atTop = change.from === 0;
      ranges.push((atTop ? MARKERS.deletedAbove : MARKERS.deletedBelow).range(doc.line(Math.min(Math.max(change.from, 1), doc.lines)).from));
      continue;
    }
    const marker = change.kind === "added" ? MARKERS.added : MARKERS.modified;
    for (let line = change.from; line <= Math.min(change.to, doc.lines); line++) ranges.push(marker.range(doc.line(line).from));
  }
  return RangeSet.of(ranges, true);
}

function computeMarkers(state: EditorState): RangeSet<GutterMarker> {
  const { source, lines } = state.field(gitBaselineField);
  if (!source || source.kind === "none" || state.doc.lines > MAX_DIFF_LINES) return RangeSet.empty;
  if (source.kind === "untracked") return markersFor(state, [{ kind: "added", from: 1, to: state.doc.lines }]);
  return markersFor(state, diffLines(lines ?? [], docLines(state)));
}

const diffScheduler = ViewPlugin.fromClass(
  class {
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly view: EditorView) {
      this.schedule(0);
    }

    update(update: ViewUpdate): void {
      const baselineChanged = update.startState.field(gitBaselineField) !== update.state.field(gitBaselineField);
      if (baselineChanged) this.schedule(0);
      else if (update.docChanged) this.schedule(DIFF_DEBOUNCE_MS);
    }

    destroy(): void {
      if (this.timer) clearTimeout(this.timer);
    }

    private schedule(delay: number): void {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.view.dispatch({ effects: setChangeMarkers.of(computeMarkers(this.view.state)) });
      }, delay);
    }
  }
);

export const gitGutter: Extension = [
  gitBaselineField,
  changeMarkersField,
  diffScheduler,
  gutter({
    class: "cm-git-gutter",
    markers: (view) => view.state.field(changeMarkersField)
  })
];
