import { openFolderBrowser } from "../stores/folderBrowserStore.js";

export async function chooseProjectFolder(): Promise<string | null> {
  const local = window.cw.local;
  return local ? local.pickProjectDir() : openFolderBrowser();
}
