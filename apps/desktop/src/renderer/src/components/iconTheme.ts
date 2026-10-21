type NameMap = Record<string, string>;

interface IconMaps {
  fileExtensions?: NameMap;
  fileNames?: NameMap;
  folderNames?: NameMap;
  folderNamesExpanded?: NameMap;
  languageIds?: NameMap;
}

export interface IconManifest extends IconMaps {
  file: string;
  folder: string;
  folderExpanded: string;
  iconDefinitions: Record<string, { iconPath: string }>;
  light?: IconMaps;
}

function lookup(manifest: IconManifest, map: keyof IconMaps, key: string, light: boolean): string | undefined {
  return (light ? manifest.light?.[map]?.[key] : undefined) ?? manifest[map]?.[key];
}

export function resolveIconName(manifest: IconManifest, rawName: string, isDir: boolean, expanded: boolean, light: boolean): string {
  const name = rawName.toLowerCase();
  if (isDir) {
    return expanded
      ? (lookup(manifest, "folderNamesExpanded", name, light) ?? manifest.folderExpanded)
      : (lookup(manifest, "folderNames", name, light) ?? manifest.folder);
  }
  const byName = lookup(manifest, "fileNames", name, light);
  if (byName) return byName;
  for (let dot = name.indexOf("."); dot >= 0; dot = name.indexOf(".", dot + 1)) {
    const byExtension = lookup(manifest, "fileExtensions", name.slice(dot + 1), light);
    if (byExtension) return byExtension;
  }
  const lastDot = name.lastIndexOf(".");
  const byLanguage = lastDot >= 0 ? lookup(manifest, "languageIds", name.slice(lastDot + 1), light) : undefined;
  return byLanguage ?? manifest.file;
}

export function iconFileName(manifest: IconManifest, icon: string): string | null {
  const path = manifest.iconDefinitions[icon]?.iconPath;
  if (!path) return null;
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.svg$/, "");
}
