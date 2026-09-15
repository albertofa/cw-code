import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const TERMINAL_FONT_STACK =
  `"CaskaydiaCove Nerd Font","Cascadia Code","JetBrainsMono Nerd Font","FiraCode Nerd Font","Hack Nerd Font",Consolas,"Courier New",monospace`;

import type { DriverName } from "../cw.js";

export function PtyTab({ sessionId, kind }: { sessionId: string; kind: DriverName | "shell" }) {
  const divRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [restartNonce, setRestartNonce] = useState(0);
  const termRef = useRef<Terminal | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const ptyTokenRef = useRef<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let offPty: (() => void) | undefined;
    let offExit: (() => void) | undefined;
    let dataHandler: { dispose: () => void } | undefined;
    let term: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let observer: ResizeObserver | null = null;
    let raf = 0;
    let nudgeRaf = 0;
    let ready = false;
    const pendingData: Array<{ ptyId: string; data: string }> = [];
    const pendingExit: Array<{ ptyId: string; token: string; exitCode: number }> = [];

    const pushSize = () => {
      if (disposed || !term || !ptyIdRef.current) return;
      try {
        window.cw.resizePty(ptyIdRef.current, term.cols, term.rows);
      } catch {
        /* Terminal closed mid-resize; safe to ignore. */
      }
    };

    const fitAndPush = () => {
      if (disposed || !term || !fitAddon || !divRef.current) return;
      if (divRef.current.clientWidth === 0 || divRef.current.clientHeight === 0) return;
      try {
        fitAddon.fit();
      } catch {
        return;
      }
      pushSize();
    };

    const scheduleFit = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(fitAndPush);
    };

    const nudgeRepaint = (ptyId: string) => {
      if (!term || term.rows < 2) return;
      const { cols, rows } = term;
      window.cw.resizePty(ptyId, cols, rows - 1);
      cancelAnimationFrame(nudgeRaf);
      nudgeRaf = requestAnimationFrame(() => {
        if (!disposed) window.cw.resizePty(ptyId, cols, rows);
      });
    };

    const start = (fontFamily: string) => {
      if (disposed || !divRef.current) return;
      term = new Terminal({
        fontSize: 13,
        fontFamily,
        scrollback: 5000,
        cursorBlink: true,
        theme: {
          background: "#1e1f22",
          foreground: "#bcbec4",
          cursor: "#dfe1e5",
          cursorAccent: "#1e1f22",
          selectionBackground: "#214184",
          black: "#1e1f22",
          red: "#e06c60",
          green: "#59a659",
          yellow: "#e8b44f",
          blue: "#548af7",
          magenta: "#9876aa",
          cyan: "#56b6c2",
          white: "#bcbec4",
          brightBlack: "#62666e",
          brightRed: "#ff8a7e",
          brightGreen: "#7fc97f",
          brightYellow: "#f5c86e",
          brightBlue: "#7aa5f8",
          brightMagenta: "#b78fd1",
          brightCyan: "#6fc3d8",
          brightWhite: "#f2f3f5"
        }
      });
      termRef.current = term;
      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(divRef.current);
      try {
        fitAddon.fit();
      } catch {
        /* Container not laid out yet; ResizeObserver will correct. */
      }

      offPty = window.cw.onPtyData((msg) => {
        if (msg.ptyId !== ptyIdRef.current) {
          if (!ptyIdRef.current) pendingData.push(msg);
          return;
        }
        if (ready && term) term.write(msg.data);
        else pendingData.push(msg);
      });
      offExit = window.cw.onPtyExit((msg) => {
        if (!ptyIdRef.current) {
          pendingExit.push(msg);
          return;
        }
        if (msg.ptyId === ptyIdRef.current && msg.token === ptyTokenRef.current) setExitCode(msg.exitCode);
      });

      window.cw.openPty(sessionId, kind).then(({ ptyId, token, replay }) => {
        if (disposed) {
          window.cw.detachPty(ptyId, token);
          return;
        }
        ptyIdRef.current = ptyId;
        ptyTokenRef.current = token;
        fitAndPush();
        if (replay && term) {
          term.write(replay);
          nudgeRepaint(ptyId);
        }
        ready = true;
        for (const chunk of pendingData) {
          if (chunk.ptyId === ptyId) term?.write(chunk.data);
        }
        pendingData.length = 0;
        const exited = pendingExit.find((entry) => entry.ptyId === ptyId && entry.token === token);
        if (exited) setExitCode(exited.exitCode);
      }).catch((err: Error) => {
        if (!disposed) setError(err.message);
      });

      dataHandler = term.onData((data) => {
        if (ptyIdRef.current) window.cw.writePty(ptyIdRef.current, data);
      });

      observer = new ResizeObserver(scheduleFit);
      observer.observe(divRef.current);
    };

    window.cw
      .getTerminalFont()
      .then((face) => start(face ? `"${face}",${TERMINAL_FONT_STACK}` : TERMINAL_FONT_STACK))
      .catch(() => start(TERMINAL_FONT_STACK));

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(nudgeRaf);
      observer?.disconnect();
      dataHandler?.dispose();
      offPty?.();
      offExit?.();
      if (ptyIdRef.current && ptyTokenRef.current) window.cw.detachPty(ptyIdRef.current, ptyTokenRef.current);
      ptyIdRef.current = null;
      ptyTokenRef.current = null;
      termRef.current?.dispose();
      termRef.current = null;
    };
  }, [sessionId, kind, restartNonce]);

  return (
    <div className="pty-wrap">
      <div ref={divRef} />
      {error && <div className="pty-error">{error}</div>}
      {exitCode !== null && (
        <div className="pty-exit">
          <span>{exitCode === 0 ? "Terminal exited." : `Terminal exited with code ${exitCode}.`}</span>
          <button
            className="btn"
            onClick={() => {
              setError(null);
              setExitCode(null);
              setRestartNonce((nonce) => nonce + 1);
            }}
          >
            Restart
          </button>
        </div>
      )}
    </div>
  );
}
