import { useState } from "react";
import { Paperclip } from "lucide-react";
import type { QueuedMessage } from "@cw-code/contracts";
import { appendToComposerDraft, untagAttachments } from "./composerDrafts.js";
import { ipcErrorMessage } from "./ipcError.js";
import { useNotifs } from "./Notifications.js";
import { useSessionRow } from "./useSessions.js";
import { useThreadBusy, useThreadEntry } from "./useThread.js";

const NO_MESSAGES: QueuedMessage[] = [];

export function QueuedMessages({ sessionId }: { sessionId: string }) {
  const messages = useThreadEntry(sessionId, "queuedMessages") ?? NO_MESSAGES;
  const busy = useThreadBusy(sessionId);
  const status = useSessionRow(sessionId)?.session.status;
  const closed = status === "resolved" || status === "archived";
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

  const edit = (message: QueuedMessage) =>
    run("Could not edit the message", async () => {
      await window.cw.unqueueMessage(sessionId, message.id);
      appendToComposerDraft(sessionId, { text: untagAttachments(message.text, message.attachments), attachments: message.attachments });
    });

  return (
    <ul className="queued-messages" aria-label="Queued messages">
      {messages.map((message) => {
        const held = message.state === "held";
        const label = held ? "Not sent" : message.removable ? "Queued" : "Sending";
        return (
          <li key={message.id} className={`queued-message${held ? " held" : ""}${message.removable ? "" : " sending"}`}>
            <span className="queued-message-state">{label}</span>
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
                disabled={busy || pending || closed}
                title={
                  closed
                    ? `This session is ${status}; reopen it to send`
                    : busy
                      ? "Available when the agent finishes"
                      : heldCount > 1
                        ? "Send all queued messages now"
                        : "Send the queued message now"
                }
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
                title="Remove the message and put it back in the composer"
                onClick={() => void edit(message)}
              >
                Edit
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
