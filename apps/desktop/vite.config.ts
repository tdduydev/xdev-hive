import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const src = fileURLToPath(new URL("./src", import.meta.url));
const repo = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  root: src,
  // Đường dẫn tương đối: Tauri nạp dist qua giao thức riêng của nó, không phải từ gốc một máy chủ web.
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": src } },
  build: { outDir: fileURLToPath(new URL("./dist", import.meta.url)), emptyOutDir: true },
  // Logo lấy thẳng từ docs/design-system, nằm ngoài src.
  server: { fs: { allow: [repo] } },
});
