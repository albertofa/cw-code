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
      emptyOutDir: true,
      rollupOptions: {
        external: ["node-pty"]
      }
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
    build: { outDir: resolve(__dirname, outRoot, "renderer"), emptyOutDir: true }
  }
});
