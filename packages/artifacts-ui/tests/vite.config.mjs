import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Dùng công cụ của web để kiểm package độc lập trong lúc T030 chưa đăng ký route, không sửa làn web.
const webRequire = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
const react = webRequire("@vitejs/plugin-react").default;
const tailwindcss = webRequire("@tailwindcss/vite").default;

export default {
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss()],
  server: { fs: { allow: [fileURLToPath(new URL("../../..", import.meta.url))] } },
};
