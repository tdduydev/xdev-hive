import { defineConfig, devices } from "@playwright/test";

const port = 4174;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://localhost:${port}`, locale: "vi-VN", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm exec vite --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    // Test không cần hub thật: /rpc và /api/auth bị thay bằng page.route (e2e/fake-hub.ts). Proxy trỏ vào cổng
    // không có gì để lời gọi nào lọt qua mock sẽ hỏng ngay thay vì chạm hub dev đang chạy.
    env: { HIVE_HUB_URL: "http://127.0.0.1:9" },
  },
});
