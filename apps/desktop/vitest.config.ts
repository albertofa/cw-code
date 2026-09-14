import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: { environment: "node", testTimeout: 20_000 },
  resolve: {
    alias: {
      electron: resolve(__dirname, "tests/electronStub.ts"),
      "@cw-code/contracts": resolve(__dirname, "../contracts/src/index.ts")
    }
  }
});
