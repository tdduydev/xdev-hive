import { defineConfig, devices } from "@playwright/test";
import { HUB_PORT, WEB_PORT, WEB_URL } from "./e2e/hub/env.ts";

/**
 * E2E với hub thật: Postgres trong Testcontainers, hub chạy bằng `node apps/hub/src/main.ts` (e2e/hub/global-setup.ts),
 * web qua Vite. Cần Docker. Chạy bằng `pnpm test:e2e:hub`.
 */
export default defineConfig({
  testDir: "e2e/hub",
  // Các test dùng chung một hub và một database, theo đúng thứ tự của luồng.
  workers: 1,
  timeout: 60_000,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "github" : "list",
  globalSetup: "./e2e/hub/global-setup.ts",
  use: { baseURL: WEB_URL, locale: "vi-VN", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm exec vite --port ${WEB_PORT} --strictPort`,
    url: WEB_URL,
    // Không dùng lại Vite đang chạy sẵn: nó có thể proxy sang hub khác.
    reuseExistingServer: false,
    env: { HIVE_HUB_URL: `http://127.0.0.1:${HUB_PORT}` },
  },
});
