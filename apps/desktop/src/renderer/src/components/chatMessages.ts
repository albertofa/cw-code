import type { ChatMessage } from "../stores/appStore.js";

export function appendAssistantText(messages: ChatMessage[], turnId: string, text: string): ChatMessage[] {
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant" && last.turnId === turnId) {
    return [...messages.slice(0, -1), { ...last, text: last.text + text }];
  }
  const existing = new Set(messages.map((m) => m.id));
  let id = `${turnId}-a`;
  for (let n = 2; existing.has(id); n++) {
    id = `${turnId}-a${n}`;
  }
  return [...messages, { id, role: "assistant", text, turnId }];
}
