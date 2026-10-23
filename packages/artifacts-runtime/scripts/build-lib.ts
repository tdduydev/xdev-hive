/**
 * Dựng bộ thư viện cho khung cách ly: `dist/lib/<tên>@<ver>/…` (ESM) và `dist/lib/lib-manifest.json` (SRI sha384).
 *
 * Thư viện được đóng gói lúc build, không tải lúc chạy (ADR 0023 mục 6): tổ chức không ra Internet vẫn chạy được và khung
 * không có đường nào nạp mã từ ngoài hub. `react` và `react-dom` luôn là import ngoài của các gói khác để cả khung chỉ có
 * một bản React, nối qua import map. Manifest nằm trong `dist/lib` để một lệnh chép thư mục (Dockerfile, resource của app)
 * mang theo cả hai.
 *
 * Chạy lại nhanh: bỏ qua khi dấu vân tay (phiên bản + script này) khớp lần dựng trước và đủ file.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build, type Plugin } from "esbuild";
import { LIB_MANIFEST_FILE, type LibEntry } from "../src/manifest.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(root, "dist");
const libDir = join(distDir, "lib");
const stampFile = join(distDir, ".lib-stamp");

// Hai dạng nguồn: CJS (react) cần liệt kê tên export để import có tên chạy được trong trình duyệt; ESM dùng `export *`.
type Source =
  | { kind: "cjs"; module: string }
  | { kind: "esm"; module: string; defaultExport?: boolean }
  | { kind: "script"; file: string };

interface Lib {
  /** Tên import trong import map. */
  name: string;
  /** Package cung cấp phiên bản. */
  pkg: string;
  /** Đường dẫn trong thư mục `<tên>@<ver>/`. */
  file: string;
  source: Source;
}

const LIBS: Lib[] = [
  { name: "react", pkg: "react", file: "index.js", source: { kind: "cjs", module: "react" } },
  {
    name: "react/jsx-runtime",
    pkg: "react",
    file: "jsx-runtime.js",
    source: { kind: "cjs", module: "react/jsx-runtime" },
  },
  { name: "react-dom", pkg: "react-dom", file: "index.js", source: { kind: "cjs", module: "react-dom" } },
  {
    name: "react-dom/client",
    pkg: "react-dom",
    file: "client.js",
    source: { kind: "cjs", module: "react-dom/client" },
  },
  { name: "recharts", pkg: "recharts", file: "index.js", source: { kind: "esm", module: "recharts" } },
  { name: "lucide-react", pkg: "lucide-react", file: "index.js", source: { kind: "esm", module: "lucide-react" } },
  {
    name: "@tailwindcss/browser",
    pkg: "@tailwindcss/browser",
    file: "index.js",
    source: { kind: "script", file: "dist/index.global.js" },
  },
  {
    name: "mermaid",
    pkg: "mermaid",
    file: "index.js",
    source: { kind: "esm", module: "mermaid", defaultExport: true },
  },
  {
    name: "markdown-it",
    pkg: "markdown-it",
    file: "index.js",
    source: { kind: "esm", module: "markdown-it", defaultExport: true },
  },
  // pdf.js chạy worker trên luồng chính (khung là origin mờ, `new Worker(url)` khác origin bị chặn) nên cần cả hai file.
  {
    name: "pdfjs-dist",
    pkg: "pdfjs-dist",
    file: "index.js",
    source: { kind: "esm", module: "pdfjs-dist/build/pdf.mjs" },
  },
  {
    name: "pdfjs-dist/worker",
    pkg: "pdfjs-dist",
    file: "worker.js",
    source: { kind: "esm", module: "pdfjs-dist/build/pdf.worker.mjs" },
  },
];

// React luôn dùng chung một bản: mọi gói khác giữ các tên này làm import ngoài, import map trỏ về cùng một file.
const SHARED = ["react", "react/jsx-runtime", "react-dom", "react-dom/client"];

const pkgDir = (pkg: string) => join(root, "node_modules", pkg);
const pkgVersion = (pkg: string): string => JSON.parse(readFileSync(join(pkgDir(pkg), "package.json"), "utf8")).version;

/**
 * Gói CJS gọi `require("react")`; esbuild đổi lời gọi này thành `__require` và ném lỗi trong trình duyệt. Lời gọi `require`
 * tới tên dùng chung được trỏ vào một module ESM nhỏ re-export import ngoài đó, còn `import` thì giữ nguyên là import ngoài.
 */
const sharedExternals: Plugin = {
  name: "shared-externals",
  setup(b) {
    b.onResolve({ filter: /^(react|react-dom)(\/.*)?$/ }, (args) => {
      if (!SHARED.includes(args.path)) return undefined;
      if (args.kind === "require-call") return { path: args.path, namespace: "shared-shim" };
      return { path: args.path, external: true };
    });
    b.onResolve({ filter: /.*/, namespace: "shared-shim" }, (args) => ({ path: args.path, external: true }));
    b.onLoad({ filter: /.*/, namespace: "shared-shim" }, (args) => ({
      contents: `export * from ${JSON.stringify(args.path)};`,
      loader: "js",
      resolveDir: root,
    }));
  },
};

function cjsStdin(lib: Lib & { source: { kind: "cjs" } }): string {
  const req = createRequire(join(root, "package.json"));
  const abs = req.resolve(lib.source.module);
  const names = Object.keys(req(lib.source.module)).filter((n) => n !== "default" && /^[A-Za-z_$][\w$]*$/.test(n));
  return [
    `import m from ${JSON.stringify(abs)};`,
    "export default m;",
    `const { ${names.join(", ")} } = m;`,
    `export { ${names.join(", ")} };`,
  ].join("\n");
}

function esmStdin(lib: Lib & { source: { kind: "esm" } }): string {
  const spec = JSON.stringify(lib.source.module);
  return `export * from ${spec};${lib.source.defaultExport ? `\nexport { default } from ${spec};` : ""}`;
}

const sri = (data: Buffer) => `sha384-${createHash("sha384").update(data).digest("base64")}`;

function fingerprint(): string {
  const h = createHash("sha256");
  h.update(readFileSync(fileURLToPath(import.meta.url)));
  h.update(readFileSync(join(root, "src/manifest.ts")));
  for (const lib of LIBS) h.update(`${lib.name}@${pkgVersion(lib.pkg)}`);
  h.update(`esbuild@${pkgVersion("esbuild")}`);
  return h.digest("hex");
}

function upToDate(stamp: string): boolean {
  if (!existsSync(stampFile) || readFileSync(stampFile, "utf8") !== stamp) return false;
  const manifestFile = join(libDir, LIB_MANIFEST_FILE);
  if (!existsSync(manifestFile)) return false;
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Record<string, LibEntry>;
  return Object.values(manifest).every((e) => existsSync(join(libDir, e.path)));
}

async function bundle(lib: Lib): Promise<Buffer> {
  const out = join(libDir, `${lib.pkg}@${pkgVersion(lib.pkg)}`, lib.file);
  mkdirSync(dirname(out), { recursive: true });
  if (lib.source.kind === "script") {
    // Tailwind dựng sẵn là script IIFE; chỉ chép, không đóng gói lại.
    const data = readFileSync(join(pkgDir(lib.pkg), lib.source.file));
    writeFileSync(out, data);
    return data;
  }
  const contents = lib.source.kind === "cjs" ? cjsStdin(lib as never) : esmStdin(lib as never);
  await build({
    stdin: { contents, resolveDir: pkgDir(lib.pkg), loader: "js", sourcefile: `${lib.name}-entry.js` },
    outfile: out,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    legalComments: "eof",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [sharedExternals],
    logLevel: "warning",
  });
  return readFileSync(out);
}

const stamp = fingerprint();
if (upToDate(stamp)) {
  console.log("artifacts-runtime: thư viện đã dựng, bỏ qua");
  process.exit(0);
}

rmSync(libDir, { recursive: true, force: true });
mkdirSync(libDir, { recursive: true });

const manifest: Record<string, LibEntry> = {};
const rows: string[] = [];
for (const lib of LIBS) {
  const data = await bundle(lib);
  const dir = `${lib.pkg}@${pkgVersion(lib.pkg)}`;
  manifest[lib.name] = {
    path: `${dir}/${lib.file}`,
    integrity: sri(data),
    kind: lib.source.kind === "script" ? "script" : "module",
    bytes: statSync(join(libDir, dir, lib.file)).size,
  };
  rows.push(
    `${lib.name.padEnd(24)} ${dir.padEnd(34)} ${(data.length / 1024).toFixed(0).padStart(6)} KiB  gzip ${(gzipSync(data).length / 1024).toFixed(0).padStart(5)} KiB`,
  );
}
writeFileSync(join(libDir, LIB_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(stampFile, stamp);
console.log(`artifacts-runtime: đã dựng ${LIBS.length} thư viện\n${rows.join("\n")}`);
