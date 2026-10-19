import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { resolveTerminalFont } from "../appearanceFonts.js";
import type { DriverName } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { terminalTheme, useTerminalColors } from "./terminalTheme.js";

function forceCellRemeasure(term: Terminal, font: { family: string; size: number }): void {
  term.options.fontFamily = "monospace";
  term.options.fontFamily = font.family;
  term.options.fontSize = font.size;
}

export function PtyTab({ sessionId, kind }: { sessionId: string; kind: DriverName | "shell" }) {
  const divRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [restartNonce, setRestartNonce] = useState(0);
  const termRef = useRef<Terminal | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const ptyTokenRef = useRef<string | null>(null);
  const appearance = useAppStore((s) => s.appearance);
  const terminalFont = resolveTerminalFont(appearance);
  const terminalFontRef = useRef(terminalFont);
  terminalFontRef.current = terminalFont;
  const refitRef = useRef<() => void>(() => {});
  const terminalColors = useTerminalColors();
  const xtermTheme = useMemo(() => terminalTheme(terminalColors.base, terminalColors), [terminalColors]);
  const xtermThemeRef = useRef(xtermTheme);
  xtermThemeRef.current = xtermTheme;

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = xtermTheme;
  }, [xtermTheme]);

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
      window.cw.resizePty(ptyIdRef.current, term.cols, term.rows);
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

    refitRef.current = scheduleFit;

    const remeasureWhenFontLoads = (created: Terminal) => {
      const { family, size } = terminalFontRef.current;
      document.fonts
        .load(`${size}px ${family}`)
        .catch((err: unknown) => {
          console.warn(`[pty] terminal font failed to load (${family}): ${err instanceof Error ? err.message : String(err)}`);
        })
        .then(() => {
          if (disposed || termRef.current !== created) return;
          forceCellRemeasure(created, terminalFontRef.current);
          scheduleFit();
        });
    };

    const start = () => {
      if (disposed || !divRef.current) return;
      term = new Terminal({
        fontSize: terminalFontRef.current.size,
        fontFamily: terminalFontRef.current.family,
        scrollback: 5000,
        cursorBlink: true,
        theme: xtermThemeRef.current
      });
      termRef.current = term;
      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(divRef.current);
      fitAndPush();
      remeasureWhenFontLoads(term);

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

    try {
      start();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Terminal failed to start.");
    }

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

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = terminalFont.family;
    term.options.fontSize = terminalFont.size;
    refitRef.current();
  }, [terminalFont.family, terminalFont.size]);

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
