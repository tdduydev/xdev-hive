import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { contract } from "@xdev-hive/contracts";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { contractMethods } from "./src/lib/rpc-methods.ts";
import { THEME_COLOR } from "./src/lib/theme.ts";

const hub = process.env.HIVE_HUB_URL ?? "http://localhost:3000";

/** `virtual:rpc-methods`: bảng method của thủ tục, xem src/lib/rpc-methods.ts. */
function rpcMethods(): Plugin {
  const id = "virtual:rpc-methods";
  return {
    name: "hive-rpc-methods",
    resolveId: (source) => (source === id ? `\0${id}` : undefined),
    load: (resolved) =>
      resolved === `\0${id}` ? `export default ${JSON.stringify(contractMethods(contract))};` : undefined,
  };
}

/**
 * PWA để cài lên màn hình chính điện thoại. Service worker chỉ giữ vỏ ứng dụng (file build có hash), xem src/sw.ts.
 * `manifest.json` thay vì `.webmanifest`: hub chỉ biết vài đuôi file và trả đuôi lạ là octet-stream.
 * Tắt trong dev: chỉ bản build mới đăng ký service worker (src/lib/pwa.ts), dev server không cần manifest.
 */
function pwa(): Plugin[] {
  // Thư mục build thật (e2e build vào thư mục tạm bằng --outDir), để đọc đúng index.html bên dưới.
  let outDir = "";
  const captureOutDir: Plugin = {
    name: "hive-pwa-outdir",
    configResolved: (config) => {
      outDir = resolve(config.root, config.build.outDir);
    },
  };
  return [
    captureOutDir,
    ...VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectRegister: false,
      manifestFilename: "manifest.json",
      injectManifest: {
        globPatterns: [
          "**/*.{js,css,html,svg,png}",
          "**/*-latin-wght-normal-*.woff2",
          "**/*-vietnamese-wght-normal-*.woff2",
        ],
        globIgnores: ["icons/**"],
        // Chỉ vỏ ứng dụng: file index.html gọi tới (script, modulepreload, CSS), font Latin/Việt, icon. Hơn 200 chunk tải lười
        // (mermaid, elk, soạn tài liệu, từng trang) cộng lại ~8 MB, không nên bắt điện thoại tải hết ngay lần mở đầu; chúng
        // vẫn tải từ mạng khi dùng tới, và dù có trong cache thì trang vẫn cần mạng để lấy dữ liệu.
        manifestTransforms: [
          async (entries) => {
            const html = await readFile(resolve(outDir, "index.html"), "utf8");
            const shell = new Set([...html.matchAll(/(?:src|href)="\/(assets\/[^"]+)"/g)].map((match) => match[1]));
            const keep = (url: string) => !url.startsWith("assets/") || /\.woff2$/.test(url) || shell.has(url);
            return { manifest: entries.filter((entry) => keep(entry.url)), warnings: [] };
          },
        ],
      },
      manifest: {
        name: "xDev Hive",
        short_name: "Hive",
        description: "Giao việc cho agent và theo dõi terminal Leader từ điện thoại.",
        lang: "vi",
        display: "standalone",
        start_url: "/",
        scope: "/",
        theme_color: THEME_COLOR.light,
        background_color: THEME_COLOR.light,
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icons/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
          { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      devOptions: { enabled: false },
    }),
  ];
}

export default defineConfig({
  plugins: [react(), tailwindcss(), rpcMethods(), pwa()],
  // Component của shadcn/ui import theo `@/…`.
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // /ws để thử worker qua cổng của Vite (HIVE_PUBLIC_URL khi dev), lệnh cài in ra địa chỉ này. /mcp và /.well-known
  // cũng vậy: token MCP có audience là HIVE_PUBLIC_URL/mcp nên CLI phải gọi qua đúng địa chỉ đó.
  server: {
    proxy: {
      "/rpc": hub,
      "/api": hub,
      // Chỉ endpoint /mcp; /mcp/consent là trang của web.
      "^/mcp(\\?.*)?$": hub,
      "/.well-known": hub,
      "/_artifact": hub,
      "/ws": { target: hub, ws: true },
    },
  },
});
