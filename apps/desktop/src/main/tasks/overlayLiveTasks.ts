import type { HistoryMessage, TaskSnapshot } from "@cw-code/contracts";
import { stateRank } from "./TaskTable.js";

const REPORTED_END_RANK = stateRank("completed");

function preferReplayed(replayed: TaskSnapshot | undefined, live: TaskSnapshot): boolean {
  return (
    replayed !== undefined &&
    replayed.runCount >= live.runCount &&
    stateRank(replayed.state) === REPORTED_END_RANK &&
    stateRank(live.state) < REPORTED_END_RANK
  );
}

export function overlayLiveTasks(messages: HistoryMessage[], tasks: TaskSnapshot[]): HistoryMessage[] {
  if (tasks.length === 0) return messages;
  const liveById = new Map(tasks.map((task) => [task.id, task]));
  let changed = false;
  const overlaid = messages.map((message) => {
    const live = message.role === "tool" ? liveById.get(message.id) : undefined;
    if (!live || preferReplayed(message.task, live)) return message;
    changed = true;
    return { ...message, task: live };
  });
  return changed ? overlaid : messages;
}
