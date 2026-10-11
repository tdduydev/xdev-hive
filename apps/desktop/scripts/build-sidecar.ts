// Dựng hive-worker cho nền tảng đang chạy vào src-tauri/binaries/hive-worker-<target triple>, tên Tauri cần cho
// externalBin. Binary không commit (.gitignore); CI và `tauri dev`/`tauri build` gọi script này trước khi biên dịch.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const desktop = fileURLToPath(new URL("../", import.meta.url));
const triple = execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();
const extension = process.platform === "win32" ? ".exe" : "";
mkdirSync(`${desktop}src-tauri/binaries`, { recursive: true });
const args = ["build", "-trimpath", "-o", `${desktop}src-tauri/binaries/hive-worker-${triple}${extension}`];
// Bản phát hành gắn phiên bản để hub biết worker nào đang chạy; dựng tại máy thì giữ 0.0.0-dev.
const version = process.env.HIVE_WORKER_VERSION;
if (version) args.push("-ldflags", `-X github.com/tdduydev/xdev-hive/worker/internal/version.Version=${version}`);
// Không nhận target tuỳ ý: Go và Rust phải cùng nền tảng để không đóng gói nhầm binary.
execFileSync("go", [...args, "./cmd/hive-worker"], {
  cwd: fileURLToPath(new URL("../../../worker/", import.meta.url)),
  env: { ...process.env, CGO_ENABLED: "0" },
  stdio: "inherit",
});
console.log(`Đã dựng sidecar cho ${triple}`);
