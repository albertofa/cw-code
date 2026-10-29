import { createContext, useContext } from "react";

export const ThreadVisibleContext = createContext(true);

export function useThreadVisible(): boolean {
  return useContext(ThreadVisibleContext);
}
