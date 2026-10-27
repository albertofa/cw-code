import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/jetbrains-mono";
import "./theme.css";
import { App } from "./App.js";
import { RootErrorBoundary } from "./components/RootErrorBoundary.js";
import { StartupGate } from "./components/StartupGate.js";
import { DesktopMissing, ServerGate } from "./server/connect.js";
import "./cw.js";

const root = document.getElementById("root");
if (root) {
  const desktop = window.cwDesktop;
  createRoot(root).render(
    <React.StrictMode>
      {desktop ? (
        <ServerGate desktop={desktop}>
          <RootErrorBoundary>
            <StartupGate>
              <App />
            </StartupGate>
          </RootErrorBoundary>
        </ServerGate>
      ) : (
        <DesktopMissing />
      )}
    </React.StrictMode>
  );
}
