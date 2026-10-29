import type { ChatMessage } from "../stores/appStore.js";
import { formatTokensShort } from "./subagents.js";

export function CompactionNote({ message }: { message: ChatMessage }) {
  const info = message.compaction ?? {};
  const details: string[] = [];
  if (info.preTokens !== undefined && info.postTokens !== undefined) {
    details.push(`${formatTokensShort(info.preTokens)} → ${formatTokensShort(info.postTokens)} tokens`);
  } else if (info.postTokens !== undefined) {
    details.push(`${formatTokensShort(info.postTokens)} tokens after`);
  } else if (info.preTokens !== undefined) {
    details.push(`${formatTokensShort(info.preTokens)} tokens before`);
  }
  if (info.droppedTokens !== undefined) {
    details.push(`dropped ${formatTokensShort(info.droppedTokens)}`);
  }
  return (
    <div className="msg-compaction">
      <span className="msg-compaction-label">{message.text || "Context compacted"}</span>
      {info.trigger && <span className="msg-compaction-tag">{info.trigger}</span>}
      {details.length > 0 && <span className="msg-compaction-detail">{details.join(" · ")}</span>}
    </div>
  );
}
