// Giao diện đăng ký máy là vài file tĩnh: chép HTML, CSS và bỏ kiểu của app.ts, không cần bundler.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const desktop = fileURLToPath(new URL("../", import.meta.url));
mkdirSync(`${desktop}dist`, { recursive: true });
for (const name of ["index.html", "style.css"]) copyFileSync(`${desktop}src/${name}`, `${desktop}dist/${name}`);
const designSystem = fileURLToPath(new URL("../../../docs/design-system/", import.meta.url));
copyFileSync(`${designSystem}assets/logos/xdev-hive-icon.svg`, `${desktop}dist/xdev-hive-icon.svg`);
const tokens = JSON.parse(readFileSync(`${designSystem}tokens.json`, "utf8")) as {
  color: { tokens: DesignToken[] };
  shadow: { tokens: DesignToken[] };
  type: { families: Record<string, string> };
};
type DesignToken = { name: string; value: string | { light: string; dark: string } };
// Sinh từ nguồn chung để desktop không giữ một bảng màu riêng có thể lệch khỏi web.
const themeProperties = (theme: "light" | "dark") =>
  [...tokens.color.tokens, ...tokens.shadow.tokens]
    .map(({ name, value }) => `  --${name}: ${typeof value === "string" ? value : value[theme]};`)
    .join("\n");
const fonts = Object.entries(tokens.type.families)
  .map(([name, value]) => `  --${name}: ${value};`)
  .join("\n");
writeFileSync(
  `${desktop}dist/tokens.css`,
  `:root {\n${themeProperties("light")}\n${fonts}\n  color-scheme: light;\n}\n` +
    `@media (prefers-color-scheme: dark) {\n  :root {\n${themeProperties("dark")}\n    color-scheme: dark;\n  }\n}\n`,
);
writeFileSync(`${desktop}dist/app.js`, stripTypeScriptTypes(readFileSync(`${desktop}src/app.ts`, "utf8")));
