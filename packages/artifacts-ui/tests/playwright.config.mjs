import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const webRequire = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
const { defineConfig } = webRequire("@playwright/test");
const port = Number(process.env.HIVE_ARTIFACT_UI_E2E_PORT ?? 42822);

export default defineConfig({
  testDir: fileURLToPath(new URL(".", import.meta.url)),
  testMatch: "library-detail.spec.mjs",
  outputDir: fileURLToPath(new URL("../../../node_modules/.cache/art-t022-playwright", import.meta.url)),
  workers: 1,
  timeout: 30_000,
  reporter: "list",
  use: { baseURL: `http://localhost:${port}`, locale: "vi-VN", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: `pnpm --filter @xdev-hive/web exec vite --config ../../packages/artifacts-ui/tests/vite.config.mjs --port ${port} --strictPort`,
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
  },
});
