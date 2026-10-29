import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type UserConfig } from "vite";

export const UI_ROOT = fileURLToPath(new URL(".", import.meta.url));

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https:",
  "connect-src 'self' ws: wss:",
  "worker-src 'self' blob:",
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join("; ");

function contentSecurityPolicyMeta(): Plugin {
  return {
    name: "cw-code-csp-meta",
    apply: "build",
    transformIndexHtml: () => [
      { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: CONTENT_SECURITY_POLICY }, injectTo: "head-prepend" }
    ]
  };
}

export const uiConfig: UserConfig = {
  root: UI_ROOT,
  base: "./",
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  plugins: [react(), contentSecurityPolicyMeta()],
  server: { port: 9369, strictPort: true },
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
  build: { outDir: "dist", emptyOutDir: true }
};

export default defineConfig(uiConfig);
