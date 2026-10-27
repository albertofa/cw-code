import "./server/stripTokenHash.js";
import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/jetbrains-mono";
import "./theme.css";
import { App } from "./App.js";
import { RootErrorBoundary } from "./components/RootErrorBoundary.js";
import { StartupGate } from "./components/StartupGate.js";
import { DesktopGate, DesktopMissing } from "./server/connect.js";
import { WebGate } from "./server/webGate.js";
import "./cw.js";

const root = document.getElementById("root");
if (root) {
  const desktop = window.cwDesktop;
  const app = (
    <RootErrorBoundary>
      <StartupGate>
        <App />
      </StartupGate>
    </RootErrorBoundary>
  );
  const gate = desktop ? (
    <DesktopGate desktop={desktop}>{app}</DesktopGate>
  ) : window.location.protocol === "file:" ? (
    <DesktopMissing />
  ) : (
    <WebGate>{app}</WebGate>
  );
  createRoot(root).render(<React.StrictMode>{gate}</React.StrictMode>);
}
