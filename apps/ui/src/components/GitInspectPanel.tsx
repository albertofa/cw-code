import type { DiffFile } from "./diffParser.js";

export const STATUS_BADGE: Record<string, string> = {
  added: "A",
  deleted: "D",
  renamed: "R",
  modified: "M"
};

export function DiffLines({ file }: { file: DiffFile }) {
  return (
    <div className="diff-body inspect-lines">
      {file.lines.length === 0 && <div className="inspect-dfile-note">{file.binary ? "Binary file not shown" : "No textual changes"}</div>}
      {file.lines.map((line, index) => (
        <div key={index} className={`diff-line ${line.type}`}>
          <span className="diff-number">{line.oldNumber ?? ""}</span>
          <span className="diff-number">{line.newNumber ?? ""}</span>
          <span className="diff-gutter">{line.type === "add" ? "+" : line.type === "del" ? "−" : line.type === "hunk" ? "⋯" : ""}</span>
          <span className="diff-text">{line.text || " "}</span>
        </div>
      ))}
    </div>
  );
}
