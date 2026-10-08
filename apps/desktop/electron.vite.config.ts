import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'";

export default defineConfig({
  // Bundle workspace TypeScript; node-pty stays native and is rebuilt by electron-builder.
  main: {
    build: { externalizeDeps: false, rollupOptions: {
      external: ["node-pty"],
      input: { index: resolve(import.meta.dirname, "src/main/index.ts"), "pty-supervisor": resolve(import.meta.dirname, "src/main/pty/supervisor.ts") },
      preserveEntrySignatures: "strict",
    } },
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, "src/renderer"),
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "xdev-hive-csp",
        // Production only: Vite's dev server needs inline scripts for HMR.
        transformIndexHtml: (html, ctx) =>
          ctx.server ? html : html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
      },
    ],
    build: {
      rollupOptions: { input: resolve(import.meta.dirname, "src/renderer/index.html") },
      // Fonts stay files: the CSP above (font-src from default-src 'self') refuses data: fonts.
      assetsInlineLimit: (file) => (/\.woff2?$/.test(file) ? false : undefined),
    },
  },
});
