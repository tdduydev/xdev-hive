import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const src = fileURLToPath(new URL("./src", import.meta.url));
const repo = fileURLToPath(new URL("../..", import.meta.url));
const design = fileURLToPath(new URL("../../docs/design-system", import.meta.url));

/** Mã commit của bản build: CI có GITHUB_SHA; dựng tại máy thì hỏi git, không có git thì "dev". */
function buildSha(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "dev";
  }
}

export default defineConfig({
  // Hiện ở cuối AppNav để người dùng biết đang chạy bản nào, build lúc nào.
  define: { __BUILD_SHA__: JSON.stringify(buildSha()), __BUILD_TIME__: JSON.stringify(new Date().toISOString()) },
  root: src,
  // Đường dẫn tương đối: Tauri nạp dist qua giao thức riêng của nó, không phải từ gốc một máy chủ web.
  base: "./",
  plugins: [react(), tailwindcss()],
  // Import theo alias thay vì ../../: `@/` là src, `@design/` là docs/design-system (logo, token chung với web).
  resolve: { alias: { "@": src, "@design": design } },
  build: { outDir: fileURLToPath(new URL("./dist", import.meta.url)), emptyOutDir: true },
  // Logo lấy thẳng từ docs/design-system (@design), nằm ngoài src.
  server: { fs: { allow: [repo] } },
});
