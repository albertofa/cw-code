import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const updateTestBuild = process.env.CW_UPDATE_TEST_BUILD === "1";
const outRoot = updateTestBuild ? "out-updatetest" : "out";

export default defineConfig({
  main: {
    define: { __CW_UPDATE_TEST_BUILD__: JSON.stringify(updateTestBuild) },
    build: {
      outDir: resolve(__dirname, outRoot, "main"),
      emptyOutDir: true
    }
  },
  preload: {
    build: { outDir: resolve(__dirname, outRoot, "preload"), emptyOutDir: true }
  },
  renderer: {
    root: "src/renderer",
    resolve: { alias: { "@": resolve(__dirname, "src/renderer/src") } },
    plugins: [react()],
    server: { port: 9369 },
    worker: { format: "es" },
    optimizeDeps: {
      include: [
        "shiki/core",
        "shiki/engine/javascript",
        "shiki/langs",
        "@codemirror/autocomplete",
        "@codemirror/commands",
        "@codemirror/language",
        "@codemirror/language-data",
        "@codemirror/search",
        "@codemirror/state",
        "@codemirror/view",
        "@lezer/highlight"
      ]
    },
    build: { outDir: resolve(__dirname, outRoot, "renderer"), emptyOutDir: true }
  }
});
