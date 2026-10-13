// Kiểm gói app sau `tauri build` (spec 008 T025): sidecar hive-worker có trong gói, chạy được, đúng phiên bản; trên
// macOS phiên bản của app khớp. Dùng: node scripts/verify-bundle.ts [đường dẫn .app hoặc thư mục target/release]
// [--version X.Y.Z]. Không đối số thì tìm trong src-tauri/target/release.
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const versionAt = args.indexOf("--version");
const expected = versionAt >= 0 ? args.splice(versionAt, 2)[1] : process.env.VERSION;
const release = fileURLToPath(new URL("../src-tauri/target/release/", import.meta.url));
const target = args[0] ?? release;
const exe = process.platform === "win32" ? ".exe" : "";

function fail(message: string): never {
  console.error(`Gói app lỗi: ${message}`);
  process.exit(1);
}

/** Thư mục chứa binary của app và sidecar: Contents/MacOS của .app trên macOS, target/release ở nơi khác. */
function binDir(): string {
  if (target.endsWith(".app")) return join(target, "Contents", "MacOS");
  if (process.platform === "darwin") {
    const macos = join(target, "bundle", "macos");
    const app = existsSync(macos) ? readdirSync(macos).find((f) => f.endsWith(".app")) : undefined;
    if (!app) fail(`không thấy .app trong ${macos}`);
    return join(macos, app, "Contents", "MacOS");
  }
  return target;
}

const dir = binDir();
const sidecar = join(dir, `hive-worker${exe}`);
if (!existsSync(sidecar)) fail(`thiếu sidecar ${sidecar}`);
try {
  accessSync(sidecar, constants.X_OK);
} catch {
  fail(`sidecar không chạy được: ${sidecar}`);
}
const workerVersion = execFileSync(sidecar, ["version"], { encoding: "utf8" }).trim();
// Bản thử dựng từ main (0.0.0) giữ worker 0.0.0-dev; bản phát hành thì worker cùng số với app.
if (expected && expected !== "0.0.0" && workerVersion !== expected) {
  fail(`sidecar báo phiên bản ${workerVersion}, cần ${expected}`);
}
if (dir.endsWith(join("Contents", "MacOS"))) {
  const plist = join(dir, "..", "Info.plist");
  const appVersion = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", plist], {
    encoding: "utf8",
  }).trim();
  if (expected && appVersion !== expected) fail(`app báo phiên bản ${appVersion}, cần ${expected}`);
  console.log(`App ${appVersion}`);
}
console.log(`Sidecar ${workerVersion}: ${sidecar}`);
