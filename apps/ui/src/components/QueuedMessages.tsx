import { useState } from "react";
import { Paperclip } from "lucide-react";
import type { QueuedMessage } from "@cw-code/contracts";
import { ipcErrorMessage } from "./ipcError.js";
import { useNotifs } from "./Notifications.js";
import { useThreadBusy, useThreadEntry } from "./useThread.js";

const NO_MESSAGES: QueuedMessage[] = [];

export function QueuedMessages({ sessionId }: { sessionId: string }) {
  const messages = useThreadEntry(sessionId, "queuedMessages") ?? NO_MESSAGES;
  const busy = useThreadBusy(sessionId);
  const [pending, setPending] = useState(false);
  const heldCount = messages.filter((message) => message.state === "held").length;

  if (messages.length === 0) return null;

  const run = async (title: string, action: () => Promise<unknown>): Promise<void> => {
    setPending(true);
    try {
      await action();
    } catch (err) {
      useNotifs.getState().push({ kind: "error", title, message: ipcErrorMessage(err) });
    } finally {
      setPending(false);
    }
  };

  return (
    <ul className="queued-messages" aria-label="Queued messages">
      {messages.map((message) => {
        const held = message.state === "held";
        return (
          <li key={message.id} className={`queued-message${held ? " held" : ""}`}>
            <span className="queued-message-state">{held ? "Not sent" : "Queued"}</span>
            <span className="queued-message-text" title={message.text}>
              {message.text}
            </span>
            {message.attachments.length > 0 && (
              <span className="queued-message-files" title={`${message.attachments.length} attachment(s)`}>
                <Paperclip size={11} aria-hidden="true" />
                {message.attachments.length}
              </span>
            )}
            {held && (
              <button
                type="button"
                className="queued-message-action"
                disabled={busy || pending}
                title={busy ? "Available when the agent finishes" : (heldCount > 1 ? "Send all queued messages now" : "Send the queued message now")}
                onClick={() => void run("Could not send", () => window.cw.flushQueue(sessionId))}
              >
                {heldCount > 1 ? "Send all now" : "Send now"}
              </button>
            )}
            {message.removable && (
              <button
                type="button"
                className="queued-message-action"
                disabled={pending}
                onClick={() => void run("Could not remove the message", () => window.cw.unqueueMessage(sessionId, message.id))}
              >
                Remove
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
