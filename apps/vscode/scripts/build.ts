// Dựng hai đích bằng esbuild: extension host (node, cjs) và webview (trình duyệt, esm) + CSS bằng Tailwind CLI.
// `--production` nén và bỏ sourcemap; `--watch` dựng lại khi sửa.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { type BuildOptions, build, context } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
const at = (p: string) => `${root}${p}`;

const common: BuildOptions = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: "info",
  absWorkingDir: root,
};

const targets: BuildOptions[] = [
  {
    ...common,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.cjs",
    platform: "node",
    format: "cjs",
    target: "node22",
    // `vscode` do extension host cấp lúc chạy, không đóng gói.
    external: ["vscode"],
    alias: { "@": at("src") },
  },
];

// Webview chưa có màn nào thì bỏ qua đích này: khung build vẫn chạy được trước khi T013 thêm main.tsx.
if (existsSync(at("webview/main.tsx"))) {
  targets.push({
    ...common,
    entryPoints: ["webview/main.tsx"],
    outdir: "dist/webview",
    platform: "browser",
    format: "esm",
    splitting: true,
    target: "es2022",
    jsx: "automatic",
    alias: { "@": at("webview") },
    define: { "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development") },
  });
}

function tailwind(): void {
  if (!existsSync(at("webview/styles.css"))) return;
  const cli = createRequire(import.meta.url).resolve("@tailwindcss/cli/dist/index.mjs");
  mkdirSync(at("dist/webview"), { recursive: true });
  execFileSync(
    process.execPath,
    [cli, "-i", at("webview/styles.css"), "-o", at("dist/webview/main.css"), ...(production ? ["--minify"] : [])],
    { stdio: "inherit" },
  );
}

rmSync(at("dist"), { recursive: true, force: true });
if (watch) {
  const contexts = await Promise.all(targets.map((options) => context(options)));
  await Promise.all(contexts.map((c) => c.watch()));
  tailwind();
} else {
  await Promise.all(targets.map((options) => build(options)));
  tailwind();
}
