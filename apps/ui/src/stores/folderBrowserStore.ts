import { create } from "zustand";

interface FolderBrowserRequest {
  initialPath: string | null;
  resolve: (path: string | null) => void;
}

interface FolderBrowserState {
  request: FolderBrowserRequest | null;
  settle: (path: string | null) => void;
}

export const useFolderBrowserStore = create<FolderBrowserState>((set, get) => ({
  request: null,
  settle: (path) => {
    const request = get().request;
    if (!request) return;
    set({ request: null });
    request.resolve(path);
  }
}));

export function openFolderBrowser(initialPath?: string): Promise<string | null> {
  useFolderBrowserStore.getState().settle(null);
  return new Promise((resolve) => {
    useFolderBrowserStore.setState({ request: { initialPath: initialPath ?? null, resolve } });
  });
}
