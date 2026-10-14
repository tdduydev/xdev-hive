import { defineConfig } from "vitest/config";

export default defineConfig({
  // 5 giây mặc định không đủ khi máy đang chạy nhiều tiến trình song song: jsdom khởi động và dựng component chậm gấp
  // hàng chục lần dù mỗi test chỉ mất vài trăm ms lúc rảnh.
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test-setup.ts"],
    testTimeout: 20_000,
  },
});
