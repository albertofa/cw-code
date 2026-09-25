import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import { App } from "./App.js";
import { RootErrorBoundary } from "./components/RootErrorBoundary.js";
import { StartupGate } from "./components/StartupGate.js";
import "./theme.css";
import "./cw.js";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <React.StrictMode>
      <RootErrorBoundary>
        <StartupGate>
          <App />
        </StartupGate>
      </RootErrorBoundary>
    </React.StrictMode>
  );
}
