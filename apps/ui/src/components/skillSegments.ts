import type { SkillMention } from "@cw-code/shared/skillMentions";

export type SkillSegment = { kind: "text"; value: string } | { kind: "skill"; name: string; raw: string };

export function skillSegments(text: string, tokens: readonly SkillMention[]): SkillSegment[] {
  const out: SkillSegment[] = [];
  let cursor = 0;
  for (const token of tokens) {
    if (token.start > cursor) out.push({ kind: "text", value: text.slice(cursor, token.start) });
    out.push({ kind: "skill", name: token.name, raw: text.slice(token.start, token.end) });
    cursor = token.end;
  }
  if (cursor < text.length) out.push({ kind: "text", value: text.slice(cursor) });
  return out;
}
