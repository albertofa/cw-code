import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  main: {
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
