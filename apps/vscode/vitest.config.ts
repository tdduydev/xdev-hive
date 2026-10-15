import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const path = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // `vscode` chỉ có trong extension host; test chạy bằng bản giả.
      vscode: path("./test/vscode-mock.ts"),
      "@": path("./src"),
    },
  },
  test: { environment: "node", include: ["src/**/*.test.ts", "shared/**/*.test.ts"] },
});
