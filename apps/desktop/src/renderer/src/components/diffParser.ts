export type DiffLineType = "add" | "del" | "ctx" | "hunk" | "meta";

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

export type DiffStatus = "modified" | "added" | "deleted" | "renamed";

export interface DiffFile {
  path: string;
  status: DiffStatus;
  added: number;
  removed: number;
  binary: boolean;
  lines: DiffLine[];
}

function unquote(p: string): string {
  let s = p.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (s.startsWith("a/") || s.startsWith("b/")) s = s.slice(2);
  return s;
}

const DIFF_GIT_RE = /^diff --git\s+("[^"]+"|\S+)\s+("[^"]+"|\S+)/;

export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;

  const push = () => {
    if (cur) files.push(cur);
    cur = null;
  };

  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const gitMatch = DIFF_GIT_RE.exec(line);
    if (gitMatch) {
      push();
      cur = {
        path: unquote(gitMatch[2]),
        status: "modified",
        added: 0,
        removed: 0,
        binary: false,
        lines: []
      };
      continue;
    }
    if (!cur) continue;

    if (line.startsWith("new file mode")) {
      cur.status = "added";
    } else if (line.startsWith("deleted file mode")) {
      cur.status = "deleted";
    } else if (line.startsWith("rename to ")) {
      cur.status = "renamed";
      cur.path = unquote(line.slice("rename to ".length));
    } else if (line.startsWith("+++ ")) {
      const p = unquote(line.slice(4).split("\t")[0]);
      if (p !== "/dev/null") cur.path = p;
    } else if (line.startsWith("--- ")) {
      // old path tracked implicitly; nothing to store
    } else if (line.startsWith("Binary files ")) {
      cur.binary = true;
      cur.lines.push({ type: "meta", text: "Binary file" });
    } else if (line.startsWith("@@")) {
      cur.lines.push({ type: "hunk", text: line });
    } else if (line.startsWith("+")) {
      cur.added += 1;
      cur.lines.push({ type: "add", text: line.slice(1) });
    } else if (line.startsWith("-")) {
      cur.removed += 1;
      cur.lines.push({ type: "del", text: line.slice(1) });
    } else if (line.startsWith(" ")) {
      cur.lines.push({ type: "ctx", text: line.slice(1) });
    } else if (line.startsWith("\\")) {
      cur.lines.push({ type: "meta", text: line });
    }
  }
  push();
  return files;
}
