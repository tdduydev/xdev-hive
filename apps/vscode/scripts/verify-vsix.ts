// Kiểm VSIX vừa đóng gói: có đủ file chạy được và không lọt file không được phát hành.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const vsix = fileURLToPath(new URL("../xdev-hive.vsix", import.meta.url));
if (!existsSync(vsix)) throw new Error("Chưa có xdev-hive.vsix: chạy `pnpm package` trước.");

const entries = execFileSync("unzip", ["-Z1", vsix], { encoding: "utf8" }).split("\n").filter(Boolean);
const required = [
  "extension/package.json",
  "extension/package.nls.json",
  "extension/package.nls.en.json",
  "extension/dist/extension.cjs",
];
const forbidden = [
  /^extension\/src\//,
  /\.test\.ts$/,
  /^extension\/test\//,
  /\.map$/,
  /^extension\/node_modules\//,
  /\.env/,
];

const missing = required.filter((f) => !entries.includes(f));
const leaked = entries.filter((f) => forbidden.some((re) => re.test(f)));
if (missing.length || leaked.length) {
  throw new Error(`VSIX sai: thiếu [${missing.join(", ")}], thừa [${leaked.join(", ")}]`);
}
console.log(`VSIX ok: ${entries.length} file`);
