import {
  BookMarked,
  BookOpen,
  Box,
  Braces,
  Database,
  File,
  FileCode,
  FileCode2,
  FileText,
  FlaskConical,
  Folder,
  GitBranch,
  Globe,
  Image,
  Info,
  KeyRound,
  Lock,
  Package,
  Palette,
  Settings,
  Terminal,
  Zap,
  type LucideIcon
} from "lucide-react";

export interface IconSpec {
  Icon: LucideIcon;
  color: string;
}

const FALLBACK_FILE: IconSpec = { Icon: File, color: "#9a9898" };

const FILE_NAMES: Record<string, IconSpec> = {
  "package.json": { Icon: Package, color: "#cb3837" },
  "package-lock.json": { Icon: Lock, color: "#e8c339" },
  "pnpm-lock.yaml": { Icon: Lock, color: "#e8c339" },
  "pnpm-workspace.yaml": { Icon: Package, color: "#e8a13c" },
  ".gitignore": { Icon: GitBranch, color: "#e8845a" },
  ".gitattributes": { Icon: GitBranch, color: "#e8845a" },
  ".gitmodules": { Icon: GitBranch, color: "#e8845a" },
  readme: { Icon: Info, color: "#519aba" },
  license: { Icon: FileText, color: "#9a9898" },
  "agents.md": { Icon: BookMarked, color: "#e8835a" },
  "claude.md": { Icon: BookMarked, color: "#e8835a" },
  dockerfile: { Icon: Box, color: "#519aba" }
};

const EXTENSIONS: Record<string, IconSpec> = {
  ts: { Icon: FileCode2, color: "#4b9fff" },
  mts: { Icon: FileCode2, color: "#4b9fff" },
  cts: { Icon: FileCode2, color: "#4b9fff" },
  tsx: { Icon: FileCode2, color: "#6fc3ff" },
  js: { Icon: FileCode, color: "#e8c339" },
  mjs: { Icon: FileCode, color: "#e8c339" },
  cjs: { Icon: FileCode, color: "#e8c339" },
  jsx: { Icon: FileCode, color: "#e8c339" },
  json: { Icon: Braces, color: "#cbcb41" },
  jsonc: { Icon: Braces, color: "#cbcb41" },
  md: { Icon: BookOpen, color: "#519aba" },
  mdx: { Icon: BookOpen, color: "#519aba" },
  css: { Icon: Palette, color: "#7aa2f7" },
  scss: { Icon: Palette, color: "#7aa2f7" },
  less: { Icon: Palette, color: "#7aa2f7" },
  html: { Icon: Globe, color: "#e8845c" },
  yml: { Icon: FileText, color: "#cb3837" },
  yaml: { Icon: FileText, color: "#cb3837" },
  toml: { Icon: Settings, color: "#9a9898" },
  ini: { Icon: Settings, color: "#9a9898" },
  cfg: { Icon: Settings, color: "#9a9898" },
  conf: { Icon: Settings, color: "#9a9898" },
  sh: { Icon: Terminal, color: "#30d158" },
  ps1: { Icon: Terminal, color: "#30d158" },
  bat: { Icon: Terminal, color: "#30d158" },
  cmd: { Icon: Terminal, color: "#30d158" },
  sql: { Icon: Database, color: "#b084eb" },
  prisma: { Icon: Database, color: "#b084eb" },
  db: { Icon: Database, color: "#b084eb" },
  sqlite: { Icon: Database, color: "#b084eb" },
  png: { Icon: Image, color: "#b084eb" },
  jpg: { Icon: Image, color: "#b084eb" },
  jpeg: { Icon: Image, color: "#b084eb" },
  gif: { Icon: Image, color: "#b084eb" },
  svg: { Icon: Image, color: "#b084eb" },
  ico: { Icon: Image, color: "#b084eb" },
  webp: { Icon: Image, color: "#b084eb" },
  log: { Icon: FileText, color: "#6e6a6a" },
  lock: { Icon: Lock, color: "#e8c339" },
  pdf: { Icon: FileText, color: "#e8845c" }
};

const TEST_PATTERN = /\.test\.|\.spec\./;

export function fileSpec(fileName: string): IconSpec {
  const lower = fileName.toLowerCase();
  const exact = FILE_NAMES[lower];
  if (exact) return exact;
  if (TEST_PATTERN.test(lower)) return { Icon: FlaskConical, color: "#30d158" };
  if (lower.startsWith("tsconfig")) return { Icon: Braces, color: "#4b9fff" };
  if (lower.startsWith("vite.") || lower.startsWith("electron.")) return { Icon: Zap, color: "#b084eb" };
  if (lower.startsWith("dockerfile") || lower.startsWith("docker-compose")) return { Icon: Box, color: "#519aba" };
  if (lower.startsWith(".env")) return { Icon: KeyRound, color: "#e8c339" };
  if (lower.startsWith(".eslint") || lower === ".prettierrc" || lower === ".editorconfig") {
    return { Icon: Settings, color: "#9a9898" };
  }
  const dot = lower.lastIndexOf(".");
  if (dot >= 0) {
    const byExt = EXTENSIONS[lower.slice(dot + 1)];
    if (byExt) return byExt;
  }
  return FALLBACK_FILE;
}

export interface FolderSpec extends IconSpec {
  openable: boolean;
}

const FALLBACK_FOLDER: FolderSpec = { Icon: Folder, color: "#8b87bd", openable: true };

const FOLDER_NAMES: Record<string, FolderSpec> = {
  src: { Icon: Folder, color: "#6f8cf5", openable: true },
  test: { Icon: Folder, color: "#30d158", openable: true },
  tests: { Icon: Folder, color: "#30d158", openable: true },
  __tests__: { Icon: Folder, color: "#30d158", openable: true },
  scripts: { Icon: Terminal, color: "#30d158", openable: false },
  packages: { Icon: Package, color: "#e8a13c", openable: false },
  docs: { Icon: BookOpen, color: "#519aba", openable: false },
  public: { Icon: Image, color: "#b084eb", openable: false },
  assets: { Icon: Image, color: "#b084eb", openable: false },
  images: { Icon: Image, color: "#b084eb", openable: false },
  img: { Icon: Image, color: "#b084eb", openable: false },
  ".git": { Icon: GitBranch, color: "#e8845a", openable: false },
  node_modules: { Icon: Package, color: "#30d158", openable: false }
};

export function folderSpec(dirName: string): FolderSpec {
  return FOLDER_NAMES[dirName.toLowerCase()] ?? FALLBACK_FOLDER;
}

function FolderGlyph({ size, color, open }: { size: number; color: string; open: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className="file-icon" aria-hidden>
      {open ? (
        <path
          d="M2 5.4a1.6 1.6 0 0 1 1.6-1.6h4l1.7 2h7.1A1.6 1.6 0 0 1 18 7.4v1H4.9L2 15.6zM4.9 9.6h13l-2.1 6.6H2.4z"
          fill={color}
        />
      ) : (
        <path
          d="M2 5.4a1.6 1.6 0 0 1 1.6-1.6h4l1.7 2h7.1A1.6 1.6 0 0 1 18 7.4v7.2a1.6 1.6 0 0 1-1.6 1.6H3.6A1.6 1.6 0 0 1 2 14.6z"
          fill={color}
        />
      )}
    </svg>
  );
}

function ComponentGlyph({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className="file-icon" aria-hidden>
      <g stroke={color} strokeWidth="2.4" strokeLinecap="round" fill="none">
        <path d="M10 3v14M3.9 6.5l12.2 7M16.1 6.5l-12.2 7" />
      </g>
    </svg>
  );
}

export function FileIcon({
  name,
  isDir = false,
  expanded = false,
  size = 15
}: {
  name: string;
  isDir?: boolean;
  expanded?: boolean;
  size?: number;
}) {
  if (isDir) {
    const spec = folderSpec(name);
    if (spec.openable) return <FolderGlyph size={size} color={spec.color} open={expanded} />;
    return <spec.Icon size={size} style={{ color: spec.color }} className="file-icon" aria-hidden />;
  }
  const lower = name.toLowerCase();
  if (lower.endsWith(".tsx") || lower.endsWith(".jsx")) {
    return <ComponentGlyph size={size} color="#6f8cf5" />;
  }
  const spec = fileSpec(name);
  return <spec.Icon size={size} style={{ color: spec.color }} className="file-icon" aria-hidden />;
}
