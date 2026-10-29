import { createHighlighterCore, type HighlighterCore, type ThemedToken } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { bundledLanguages } from "shiki/langs";
import { SHIKI_THEME_NAME, shikiTheme } from "./shikiTheme.js";
import type { ShikiRequest, ShikiResponse } from "./shikiProtocol.js";

const FONT_ITALIC = 1;
const FONT_BOLD = 2;
const FONT_UNDERLINE = 4;
const FONT_STRIKETHROUGH = 8;

let highlighter: Promise<HighlighterCore> | null = null;
const loadedLangs = new Map<string, Promise<void>>();

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [shikiTheme],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true })
  });
  return highlighter;
}

function ensureLanguage(core: HighlighterCore, lang: string): Promise<void> {
  let pending = loadedLangs.get(lang);
  if (!pending) {
    const load = bundledLanguages[lang as keyof typeof bundledLanguages];
    pending = load ? core.loadLanguage(load) : Promise.reject(new Error(`unknown language: ${lang}`));
    loadedLangs.set(lang, pending);
  }
  return pending;
}

function styleOf(token: ThemedToken): string {
  const parts: string[] = [];
  if (token.color && token.color !== shikiTheme.fg) parts.push(`color:${token.color}`);
  const font = token.fontStyle ?? 0;
  if (font > 0) {
    if (font & FONT_ITALIC) parts.push("font-style:italic");
    if (font & FONT_BOLD) parts.push("font-weight:600");
    const lines = [font & FONT_UNDERLINE ? "underline" : "", font & FONT_STRIKETHROUGH ? "line-through" : ""].filter(Boolean);
    if (lines.length > 0) parts.push(`text-decoration:${lines.join(" ")}`);
  }
  return parts.join(";");
}

function encode(lines: ThemedToken[][]): { spans: Int32Array; styles: string[] } {
  const styles: string[] = [];
  const styleIndex = new Map<string, number>();
  const out: number[] = [];
  for (const line of lines) {
    for (const token of line) {
      if (token.content.length === 0) continue;
      const style = styleOf(token);
      if (!style) continue;
      let index = styleIndex.get(style);
      if (index === undefined) {
        index = styles.length;
        styles.push(style);
        styleIndex.set(style, index);
      }
      out.push(token.offset, token.offset + token.content.length, index);
    }
  }
  return { spans: Int32Array.from(out), styles };
}

async function handle(request: ShikiRequest): Promise<ShikiResponse> {
  try {
    const core = await getHighlighter();
    await ensureLanguage(core, request.lang);
    const tokens = core.codeToTokensBase(request.text, {
      lang: request.lang,
      theme: SHIKI_THEME_NAME,
      tokenizeMaxLineLength: 5000,
      tokenizeTimeLimit: 500
    });
    const { spans, styles } = encode(tokens);
    return { id: request.id, ok: true, spans, styles };
  } catch (err) {
    return { id: request.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

self.onmessage = (event: MessageEvent<ShikiRequest>) => {
  void handle(event.data).then((response) => {
    if (response.ok) (self as unknown as Worker).postMessage(response, [response.spans.buffer]);
    else (self as unknown as Worker).postMessage(response);
  });
};
