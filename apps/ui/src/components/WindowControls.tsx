import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import type { ShellActions } from "../cw.js";

export function WindowControls() {
  const shell = window.cw.shell;
  return shell ? <ShellWindowControls shell={shell} /> : null;
}

function ShellWindowControls({ shell }: { shell: ShellActions }) {
  const [maxed, setMaxed] = useState(false);

  useEffect(() => {
    shell.isWindowMaximized().then(setMaxed).catch(() => {});
    return shell.onWindowMaximized(setMaxed);
  }, [shell]);

  return (
    <div className="win-controls win-controls-overlay" onDoubleClick={(e) => e.stopPropagation()}>
      <button className="win-btn" onClick={() => shell.minimizeWindow()} title="Minimize" aria-label="Minimize">
        <Minus size={14} />
      </button>
      <button
        className="win-btn"
        onClick={() => shell.toggleMaximizeWindow()}
        title={maxed ? "Restore" : "Maximize"}
        aria-label={maxed ? "Restore" : "Maximize"}
      >
        {maxed ? <Copy size={12} /> : <Square size={12} />}
      </button>
      <button className="win-btn close" onClick={() => shell.closeWindow()} title="Close" aria-label="Close">
        <X size={15} />
      </button>
    </div>
  );
}
