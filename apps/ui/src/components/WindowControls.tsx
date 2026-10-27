import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";

export function WindowControls() {
  const [maxed, setMaxed] = useState(false);

  useEffect(() => {
    window.cw.isWindowMaximized().then(setMaxed).catch(() => {});
    return window.cw.onWindowMaximized(setMaxed);
  }, []);

  return (
    <div className="win-controls win-controls-overlay" onDoubleClick={(e) => e.stopPropagation()}>
      <button className="win-btn" onClick={() => window.cw.minimizeWindow()} title="Minimize" aria-label="Minimize">
        <Minus size={14} />
      </button>
      <button
        className="win-btn"
        onClick={() => window.cw.toggleMaximizeWindow()}
        title={maxed ? "Restore" : "Maximize"}
        aria-label={maxed ? "Restore" : "Maximize"}
      >
        {maxed ? <Copy size={12} /> : <Square size={12} />}
      </button>
      <button className="win-btn close" onClick={() => window.cw.closeWindow()} title="Close" aria-label="Close">
        <X size={15} />
      </button>
    </div>
  );
}
