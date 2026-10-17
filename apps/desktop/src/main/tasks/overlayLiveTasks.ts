import type { HistoryMessage, TaskSnapshot } from "@cw-code/contracts";

export function overlayLiveTasks(messages: HistoryMessage[], tasks: TaskSnapshot[]): HistoryMessage[] {
  if (tasks.length === 0) return messages;
  const liveById = new Map(tasks.map((task) => [task.id, task]));
  let changed = false;
  const overlaid = messages.map((message) => {
    const live = message.role === "tool" ? liveById.get(message.id) : undefined;
    if (!live) return message;
    changed = true;
    return { ...message, task: live };
  });
  return changed ? overlaid : messages;
}
