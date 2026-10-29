import manifest from "material-icon-theme/dist/material-icons.json";
import { iconFileName, resolveIconName, type IconManifest } from "./iconTheme.js";

const theme = manifest as unknown as IconManifest;

const urls = import.meta.glob<string>("../../node_modules/material-icon-theme/icons/*.svg", {
  query: "?no-inline",
  import: "default",
  eager: true
});

const urlByFile = new Map(Object.entries(urls).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1, -".svg".length), url]));

function urlFor(icon: string): string | undefined {
  const file = iconFileName(theme, icon);
  return file ? urlByFile.get(file) : undefined;
}

export function iconUrl(name: string, isDir: boolean, expanded: boolean, light: boolean): string | null {
  return (
    urlFor(resolveIconName(theme, name, isDir, expanded, light)) ??
    urlFor(isDir ? (expanded ? theme.folderExpanded : theme.folder) : theme.file) ??
    null
  );
}
