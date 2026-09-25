import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const updateTestBuild = process.env.CW_UPDATE_TEST_BUILD === "1";

export default defineConfig({
  main: {
    define: { __CW_UPDATE_TEST_BUILD__: JSON.stringify(updateTestBuild) },
    build: {
      rollupOptions: {
        external: ["node-pty"]
      }
    }
  },
  preload: {},
  renderer: {
    root: "src/renderer",
    resolve: { alias: { "@": resolve(__dirname, "src/renderer/src") } },
    plugins: [react()],
    server: { port: 9369 }
  }
});
