import { defineConfig } from "vitest/config";

export default defineConfig({
  // Component chỉ cần DOM giả; test thuần (patch.test.ts) vẫn chạy được trong môi trường này.
  // 5 giây mặc định không đủ khi máy đang chạy nhiều tiến trình song song (agent, CI cục bộ): jsdom khởi động và dựng
  // component chậm gấp hàng chục lần dù mỗi test chỉ mất vài trăm ms lúc rảnh.
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test-setup.ts"],
    testTimeout: 20_000,
  },
});
