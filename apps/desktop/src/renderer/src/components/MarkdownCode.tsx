import { memo, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { ResolvedFenceLanguage } from "../editor/languageMap.js";
import { cancelShikiHighlight, highlightWithShiki, type ShikiTokens } from "../editor/shikiClient.js";
import { SHIKI_MAX_CHARS } from "../editor/shikiProtocol.js";

const STYLE_CACHE = new Map<string, CSSProperties>();

function cssProperties(style: string): CSSProperties {
  let cached = STYLE_CACHE.get(style);
  if (cached) return cached;
  const declarations: Record<string, string> = {};
  for (const part of style.split(";")) {
    const colon = part.indexOf(":");
    if (colon <= 0) continue;
    const prop = part.slice(0, colon).trim();
    const value = part.slice(colon + 1).trim();
    if (!prop || !value) continue;
    const key = prop.startsWith("--") ? prop : prop.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    declarations[key] = value;
  }
  cached = declarations as CSSProperties;
  STYLE_CACHE.set(style, cached);
  return cached;
}

export function highlightedSpans(text: string, tokens: ShikiTokens): ReactNode[] {
  const nodes: ReactNode[] = [];
  const { spans, styles } = tokens;
  let cursor = 0;
  let key = 0;
  for (let i = 0; i + 2 < spans.length; i += 3) {
    const from = Math.max(spans[i], cursor);
    const to = Math.min(spans[i + 1], text.length);
    if (to <= from) continue;
    if (from > cursor) nodes.push(text.slice(cursor, from));
    const style = styles[spans[i + 2]];
    if (style) {
      nodes.push(
        <span key={key++} style={cssProperties(style)}>
          {text.slice(from, to)}
        </span>
      );
    } else {
      nodes.push(text.slice(from, to));
    }
    cursor = to;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

interface HighlightedText {
  text: string;
  lang: string;
  tokens: ShikiTokens;
}

let nextOwner = 0;

export const MarkdownCode = memo(function MarkdownCode({
  text,
  className,
  language
}: {
  text: string;
  className?: string;
  language: ResolvedFenceLanguage;
}) {
  const [owner] = useState(() => `md:${nextOwner++}`);
  const [highlight, setHighlight] = useState<HighlightedText | null>(null);
  const lang = language.shiki;

  useEffect(() => {
    if (!lang || text.length === 0 || text.length > SHIKI_MAX_CHARS) {
      setHighlight(null);
      return;
    }
    let live = true;
    highlightWithShiki(owner, lang, text).then((tokens) => {
      if (live) setHighlight(tokens ? { text, lang, tokens } : null);
    });
    return () => {
      live = false;
      cancelShikiHighlight(owner);
    };
  }, [owner, lang, text]);

  const tokens = highlight && highlight.text === text && highlight.lang === lang ? highlight.tokens : null;
  const spans = useMemo(() => (tokens ? highlightedSpans(text, tokens) : null), [text, tokens]);
  const codeClassName = spans ? (className ? `${className} md-code-hl` : "md-code-hl") : className;

  return <code className={codeClassName}>{spans ?? text}</code>;
});
