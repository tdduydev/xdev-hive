import type { LibManifest } from "./manifest.ts";

export const LIB_BASE = "https://hive.example.com/_artifact/lib/";

const entry = (path: string, kind: "module" | "script" = "module") => ({
  path,
  integrity: `sha384-${path.replace(/[^A-Za-z0-9]/g, "A").padEnd(64, "A")}`,
  kind,
  bytes: 1,
});

/** Manifest giả cho test dựng tài liệu: không cần chạy build thư viện. */
export const TEST_MANIFEST: LibManifest = {
  react: entry("react@19.0.0/index.js"),
  "react/jsx-runtime": entry("react@19.0.0/jsx-runtime.js"),
  "react-dom": entry("react-dom@19.0.0/index.js"),
  "react-dom/client": entry("react-dom@19.0.0/client.js"),
  recharts: entry("recharts@3.0.0/index.js"),
  "lucide-react": entry("lucide-react@1.0.0/index.js"),
  "@tailwindcss/browser": entry("@tailwindcss/browser@4.0.0/index.js", "script"),
  mermaid: entry("mermaid@12.0.0/index.js"),
  "markdown-it": entry("markdown-it@15.0.0/index.js"),
  "pdfjs-dist": entry("pdfjs-dist@6.0.0/index.js"),
  "pdfjs-dist/worker": entry("pdfjs-dist@6.0.0/worker.js"),
};
