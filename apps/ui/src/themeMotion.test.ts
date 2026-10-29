import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

const SCANNED_STYLESHEETS = [
  "./theme.css",
  "./components/appearance.css",
  "./components/files/files.css",
  "./components/loading.css",
  "./components/modelPicker.css",
  "./components/prInbox.css",
  "./components/sessionOverview.css",
  "./components/settingsPage.css",
  "./components/toolRail.css",
  "./components/turnChanges.css"
];

const REDUCED_MOTION_BLOCK = /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}/g;
const RULE = /([^{}]+)\{([^{}]*)\}/g;
const ANIMATION = /(^|[\s;])animation(-name)?\s*:/;

interface Rule {
  selectors: string[];
  at: number;
  animates: boolean;
}

function readStylesheet(path: string): string | null {
  try {
    return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
  } catch {
    return null;
  }
}

function reducedMotionSpans(css: string): Array<[number, number]> {
  return [...css.matchAll(REDUCED_MOTION_BLOCK)].map((m) => [m.index, m.index + m[0].length] as [number, number]);
}

function rulesOutside(css: string, spans: Array<[number, number]>): Rule[] {
  const rules: Rule[] = [];
  for (const match of css.matchAll(RULE)) {
    const at = match.index;
    if (spans.some(([from, to]) => at >= from && at < to)) continue;
    if (match[1].includes("@")) continue;
    rules.push({
      selectors: match[1].split(",").map((s) => s.trim()),
      at,
      animates: ANIMATION.test(match[2])
    });
  }
  return rules;
}

/**
 * A reduced-motion override only wins over a same-specificity base rule when it
 * comes later in the file, so the two cannot be written in the wrong order.
 */
describe("reduced-motion overrides", () => {
  it.each(SCANNED_STYLESHEETS)("are declared after the rules they cancel in %s", (path) => {
    const css = readStylesheet(path);
    if (css === null) return;
    const spans = reducedMotionSpans(css);
    const base = rulesOutside(css, spans).filter((rule) => rule.animates);
    const defeated: string[] = [];

    for (const [from, to] of spans) {
      const block = css.slice(from, to);
      for (const rule of block.slice(block.indexOf("{") + 1).matchAll(RULE)) {
        if (!/animation\s*:\s*none/.test(rule[2])) continue;
        for (const selector of rule[1].split(",").map((s) => s.trim())) {
          if (base.some((candidate) => candidate.at > to && candidate.selectors.includes(selector))) {
            defeated.push(selector);
          }
        }
      }
    }

    expect(defeated).toEqual([]);
  });
});
