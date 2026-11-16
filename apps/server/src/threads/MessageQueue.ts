import { randomUUID } from "node:crypto";
import type { QueuedMessage } from "@cw-code/contracts";
import type { SessionStore } from "../sessions/SessionStore.js";

export interface MessageQueueDeps {
  store: Pick<SessionStore, "getSession" | "setQueuedMessages">;
  refresh: (sessionId: string) => void;
  now?: () => number;
  newId?: () => string;
}

export interface MessageInput {
  text: string;
  attachments?: string[];
  skills?: string[];
}

export interface CombinedMessages {
  prompt: string;
  attachments: string[];
  skills?: string[];
}

export function combineMessages(messages: QueuedMessage[]): CombinedMessages {
  const attachments = [...new Set(messages.flatMap((message) => message.attachments))];
  const skills = [...new Set(messages.flatMap((message) => message.skills ?? []))];
  return {
    prompt: messages.map((message) => message.text).join("\n\n"),
    attachments,
    ...(skills.length > 0 ? { skills } : {})
  };
}

export class MessageQueue {
  constructor(private readonly deps: MessageQueueDeps) {}

  list(sessionId: string): QueuedMessage[] {
    return this.deps.store.getSession(sessionId)?.queuedMessages ?? [];
  }

  find(sessionId: string, messageId: string): QueuedMessage | undefined {
    return this.list(sessionId).find((message) => message.id === messageId);
  }

  extras(sessionId: string): { queuedMessages: QueuedMessage[] } {
    return { queuedMessages: this.list(sessionId) };
  }

  add(sessionId: string, input: MessageInput): QueuedMessage {
    const message: QueuedMessage = {
      id: this.deps.newId?.() ?? randomUUID(),
      text: input.text,
      attachments: input.attachments ?? [],
      ...(input.skills?.length ? { skills: input.skills } : {}),
      createdAt: this.deps.now?.() ?? Date.now(),
      state: "sending",
      removable: true
    };
    this.write(sessionId, [...this.list(sessionId), message]);
    return message;
  }

  update(sessionId: string, messageId: string, patch: Partial<Pick<QueuedMessage, "state" | "removable">>): void {
    const messages = this.list(sessionId);
    const current = messages.find((message) => message.id === messageId);
    if (!current) return;
    if (Object.entries(patch).every(([key, value]) => current[key as keyof typeof patch] === value)) return;
    this.write(
      sessionId,
      messages.map((message) => (message.id === messageId ? { ...message, ...patch } : message))
    );
  }

  remove(sessionId: string, messageIds: string[]): QueuedMessage[] {
    const ids = new Set(messageIds);
    const messages = this.list(sessionId);
    const removed = messages.filter((message) => ids.has(message.id));
    if (removed.length > 0) this.write(sessionId, messages.filter((message) => !ids.has(message.id)));
    return removed;
  }

  restore(sessionId: string, messages: QueuedMessage[]): void {
    if (messages.length === 0) return;
    const held = messages.map((message): QueuedMessage => ({ ...message, state: "held", removable: true }));
    this.write(sessionId, [...held, ...this.list(sessionId)]);
  }

  holdAll(sessionId: string): void {
    const messages = this.list(sessionId);
    if (messages.every((message) => message.state === "held" && message.removable)) return;
    this.write(
      sessionId,
      messages.map((message): QueuedMessage => ({ ...message, state: "held", removable: true }))
    );
  }

  private write(sessionId: string, messages: QueuedMessage[]): void {
    this.deps.store.setQueuedMessages(sessionId, messages);
    this.deps.refresh(sessionId);
  }
}
