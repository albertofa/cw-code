import { deriveProjectIdentity } from "./projectIdentity.js";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function ProjectMonogram({ name, size = 16, title }: { name: string; size?: number; title?: string }) {
  const { monogram, color } = deriveProjectIdentity(name);
  const isSingleGlyph = Array.from(graphemeSegmenter.segment(monogram)).length === 1;
  return (
    <span
      className="project-mono"
      style={{ color, width: size, height: size }}
      {...(title ? { title, role: "img", "aria-label": title } : { "aria-hidden": true })}
    >
      <svg viewBox="0 0 16 16">
        <text
          x="8"
          y="10.8"
          textAnchor="middle"
          fill="currentColor"
          fontSize="8.25"
          fontWeight="700"
          textLength={isSingleGlyph ? 6 : 12}
          lengthAdjust="spacingAndGlyphs"
          textRendering="geometricPrecision"
        >
          {monogram}
        </text>
      </svg>
    </span>
  );
}
