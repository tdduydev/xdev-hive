import { defineConfig, devices } from "@playwright/test";

/*
 * HIVE_WEB_E2E_PORT cho các worktree chạy e2e cùng lúc trên một máy mỗi nơi một cổng. Chỉ dùng lại Vite đang chạy khi
 * chạy tại máy với cổng mặc định: đặt cổng riêng là để tách khỏi server khác, còn server lạ đang giữ cổng đó có thể là
 * Vite của worktree khác (code khác) và làm test hỏng ngẫu nhiên.
 */
const portEnv = process.env.HIVE_WEB_E2E_PORT;
const port = portEnv ? Number(portEnv) : 4174;
if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
  throw new Error(`HIVE_WEB_E2E_PORT không hợp lệ: ${portEnv}`);
}
// Nhiều worktree cùng chạy CI có thể làm các bài chờ render hết giờ; cho phép giới hạn số trình duyệt mỗi lượt.
const workersEnv = process.env.HIVE_WEB_E2E_WORKERS;
const workers = workersEnv ? Number(workersEnv) : undefined;
if (workers !== undefined && (!Number.isInteger(workers) || workers < 1)) {
  throw new Error(`HIVE_WEB_E2E_WORKERS không hợp lệ: ${workersEnv}`);
}
const preview = process.env.HIVE_WEB_E2E_PREVIEW === "1";

export default defineConfig({
  testDir: "e2e",
  // e2e/hub cần hub thật và Docker, chạy riêng bằng playwright.hub.config.ts.
  testIgnore: "hub/**",
  fullyParallel: true,
  ...(workers === undefined ? {} : { workers }),
  timeout: process.env.CI ? 60_000 : 30_000,
  forbidOnly: !!process.env.CI,
  // CI chia test thành nhiều shard: mỗi shard ghi báo cáo blob để job báo cáo gộp lại thành một báo cáo HTML.
  reporter: process.env.CI ? [["github"], ["blob"]] : "list",
  use: { baseURL: `http://localhost:${port}`, locale: "vi-VN", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // ci:local đã build trước bước này; preview giúp kiểm chính bundle sẽ phục vụ và tránh biên dịch lại khi chạy nhiều màn.
    command: `pnpm exec vite${preview ? " preview" : ""} --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI && !portEnv && !preview,
    // Test không cần hub thật: /rpc và /api/auth bị thay bằng page.route (e2e/fake-hub.ts). Proxy trỏ vào cổng
    // không có gì để lời gọi nào lọt qua mock sẽ hỏng ngay thay vì chạm hub dev đang chạy.
    env: { HIVE_HUB_URL: "http://127.0.0.1:9" },
  },
});
