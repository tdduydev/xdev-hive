// Sinh src/generated/tokens.css từ docs/design-system/tokens.json rồi dựng giao diện bằng Vite vào dist/.
// `--tokens-only` chỉ sinh token, cho `pnpm dev:ui` xem giao diện trong trình duyệt.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const desktop = fileURLToPath(new URL("../", import.meta.url));
const tokens = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../docs/design-system/tokens.json", import.meta.url)), "utf8"),
) as {
  color: { tokens: DesignToken[] };
  radius: { tokens: DesignToken[] };
};
type DesignToken = { name: string; value: string | { light: string; dark: string } };

// Sinh từ nguồn chung để desktop không giữ một bảng màu riêng có thể lệch khỏi web.
const values = (theme: "light" | "dark") =>
  [...tokens.color.tokens, ...tokens.radius.tokens]
    .filter(({ value }) => theme === "light" || typeof value !== "string")
    .map(({ name, value }) => `  --${name}: ${typeof value === "string" ? value : value[theme]};`)
    .join("\n");
mkdirSync(`${desktop}src/generated`, { recursive: true });
writeFileSync(
  `${desktop}src/generated/tokens.css`,
  `:root {\n${values("light")}\n}\n\n.dark {\n${values("dark")}\n}\n`,
);

if (!process.argv.includes("--tokens-only")) {
  await build({ configFile: `${desktop}vite.config.ts` });
}
