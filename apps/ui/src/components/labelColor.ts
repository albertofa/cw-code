import type { CSSProperties } from "react";

/** Inline style that tints a label chip with its GitHub color; CSS derives fill, border and text from it. */
export function labelChipStyle(colors: Record<string, string> | undefined, label: string): CSSProperties | undefined {
  const color = colors?.[label];
  return color ? ({ "--label-color": color } as CSSProperties) : undefined;
}
