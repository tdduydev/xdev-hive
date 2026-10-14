import { defineConfig } from "vitest/config";

// Test jsdom (khai báo ở đầu từng file) chậm gấp hàng chục lần khi máy đang chạy nhiều tiến trình song song nên 5 giây
// mặc định không đủ.
export default defineConfig({ test: { testTimeout: 20_000 } });
