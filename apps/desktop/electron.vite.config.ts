import { defineConfig } from "electron-vite";
import { resolve } from "node:path";
import { UI_ROOT, uiConfig } from "../ui/vite.config";

const updateTestBuild = process.env.CW_UPDATE_TEST_BUILD === "1";
const outRoot = updateTestBuild ? "out-updatetest" : "out";

export default defineConfig(({ command }) => ({
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
  ...(command === "serve" ? { renderer: { ...uiConfig, build: { rollupOptions: { input: resolve(UI_ROOT, "index.html") } } } } : {})
}));
