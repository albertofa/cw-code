import { useEffect } from "react";
import { create } from "zustand";
import type { CommandOption } from "@cw-code/contracts";
import { skillCommands } from "../components/slashCommands.js";
import { ipcErrorMessage } from "../components/ipcError.js";

interface SessionSkillsState {
  bySession: Record<string, ReadonlySet<string>>;
  publish(sessionId: string, list: readonly CommandOption[]): void;
  ensure(sessionId: string): void;
}

const inflight = new Set<string>();
const NONE: ReadonlySet<string> = new Set();

export const useSessionSkillsStore = create<SessionSkillsState>((set, get) => ({
  bySession: {},
  publish(sessionId, list) {
    const names = skillCommands(list).map((skill) => skill.name);
    const previous = get().bySession[sessionId];
    if (previous && previous.size === names.length && names.every((name) => previous.has(name))) return;
    set({ bySession: { ...get().bySession, [sessionId]: new Set(names) } });
  },
  ensure(sessionId) {
    if (get().bySession[sessionId] || inflight.has(sessionId)) return;
    inflight.add(sessionId);
    window.cw
      .listCommands(sessionId)
      .then((list) => get().publish(sessionId, list))
      .catch((err: unknown) => console.warn(`skill list unavailable for ${sessionId}: ${ipcErrorMessage(err)}`))
      .finally(() => inflight.delete(sessionId));
  }
}));

export function useSessionSkillNames(sessionId: string, wanted: boolean): ReadonlySet<string> {
  const names = useSessionSkillsStore((s) => s.bySession[sessionId]);
  useEffect(() => {
    if (wanted) useSessionSkillsStore.getState().ensure(sessionId);
  }, [sessionId, wanted]);
  return names ?? NONE;
}
