// Builds the desktop app for every platform on this Mac and publishes a GitHub release (no CI).
//   npm run release -w @xdev-hive/desktop            (version from package.json, tag v<version>)
//   npm run release -w @xdev-hive/desktop -- --dry   (build and list the files, publish nothing)
//   npm run release -w @xdev-hive/desktop -- --hub-only   (skip GitHub: upload the built files to the hub again)
//   npm run release -w @xdev-hive/desktop -- --whatsnew <file>   (use edited release notes)
// Needs: a clean checkout of origin/main, `gh` signed in with push access. macOS builds are ad-hoc
// signed (no Developer ID yet); Windows installers are unsigned.
// With HIVE_RELEASE_HUB (https://hive.example) and HIVE_RELEASE_TOKEN (a hub admin's token) the builds also go to the
// hub, which hands them to machines as updates (roadmap 22i; admins pick the version on Phiên bản app).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { uploadToHub } from "#desktop/scripts/hub-upload.mjs";
import { generateWhatsNew, readWhatsNewOverride } from "#desktop/scripts/whatsnew.mjs";

const desktop = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(desktop, "..", "..");
const release = path.join(desktop, "release");
const dry = process.argv.includes("--dry");
const hubOnly = process.argv.includes("--hub-only");
// Read before cleaning release/, since the supplied draft may live there.
const whatsNewOverride = readWhatsNewOverride(process.argv.slice(2), readFileSync);
const { version } = JSON.parse(readFileSync(path.join(desktop, "package.json"), "utf8"));
const tag = `v${version}`;

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", cwd: desktop, ...opts });
const out = (cmd, args) => execFileSync(cmd, args, { cwd: repoRoot, encoding: "utf8" }).trim();

// Release only what is on main, so the tag points at the code that was built.
if (!dry && !hubOnly) {
  if (out("git", ["status", "--porcelain"])) throw new Error("Working tree is not clean.");
  run("git", ["fetch", "-q", "origin", "main", "--tags"], { cwd: repoRoot });
  if (out("git", ["rev-parse", "HEAD"]) !== out("git", ["rev-parse", "origin/main"])) throw new Error("HEAD is not origin/main.");
  if (out("git", ["tag", "--list", tag])) throw new Error(`Tag ${tag} exists: bump "version" in apps/desktop/package.json.`);
}

if (!hubOnly) rmSync(release, { recursive: true, force: true });
if (!hubOnly) run("npm", ["run", "build"]);
const builder = (...args) => run("npx", ["electron-builder", ...args, "--publish", "never"], { env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" } });
if (!hubOnly) {
  builder("--mac", "--arm64", "--x64");
  // node-gyp cannot cross-compile node-pty from a Mac: Windows takes the package's N-API prebuilds as they are, and
  // Linux has none (the remote terminal reports node-pty missing there until one is built on Linux).
  const noRebuild = "-c.npmRebuild=false";
  // One installer per architecture (a combined one would double the download).
  builder("--win", "--x64", noRebuild);
  builder("--win", "--arm64", noRebuild);
  builder("--linux", "--x64", "--arm64", noRebuild);
}

const assets = readdirSync(release)
  .filter((f) => /\.(dmg|zip|exe|AppImage|deb)$/.test(f))
  .sort()
  .map((f) => path.join(release, f));
// Ubuntu's self-updating install (no password on update): GitHub only, the hub hands out builds, not scripts.
const installScript = path.join(release, "install-linux.sh");
copyFileSync(path.join(desktop, "scripts", "install-linux.sh"), installScript);
// The script runs as the person, so it is checked like any build before it is trusted.
const sums = [...assets, installScript].map((f) => `${createHash("sha256").update(readFileSync(f)).digest("hex")}  ${path.basename(f)}`).join("\n");
const sumsFile = path.join(release, "SHA256SUMS.txt");
writeFileSync(sumsFile, `${sums}\n`);
for (const f of assets) console.log(`${(statSync(f).size / 1e6).toFixed(0).padStart(5)} MB  ${path.basename(f)}`);

const whatsNewDraft = whatsNewOverride ?? generateWhatsNew(repoRoot, tag);
writeFileSync(path.join(release, "WHATSNEW.md"), whatsNewDraft);

if (dry) {
  console.log(`\n--dry: nothing published (${tag}).`);
  process.exit(0);
}

/** Uploads every build and the notes to the hub, when HIVE_RELEASE_HUB and HIVE_RELEASE_TOKEN say where. */
async function toHub(notes) {
  const hub = process.env.HIVE_RELEASE_HUB;
  const token = process.env.HIVE_RELEASE_TOKEN;
  if (!hub || !token) {
    console.log("HIVE_RELEASE_HUB / HIVE_RELEASE_TOKEN not set: the hub does not get this release.");
    return;
  }
  await uploadToHub({ hub, token, version, assets, notes });
}

const whatsNew = whatsNewDraft;
const notes = `## Tải về

| Máy | File |
|---|---|
| macOS Apple Silicon (M1…) | \`xdev-hive-${version}-mac-arm64.dmg\` |
| macOS Intel | \`xdev-hive-${version}-mac-x64.dmg\` |
| Windows x64 | \`xdev-hive-${version}-win-x64-setup.exe\` |
| Windows ARM | \`xdev-hive-${version}-win-arm64-setup.exe\` |
| Ubuntu, tự cập nhật (khuyên dùng) | \`install-linux.sh\` + AppImage bên dưới |
| Ubuntu/Debian x64 | \`xdev-hive-${version}-linux-amd64.deb\` |
| Ubuntu/Debian ARM64 | \`xdev-hive-${version}-linux-arm64.deb\` |
| Linux x64 | \`xdev-hive-${version}-linux-x86_64.AppImage\` |
| Linux ARM64 | \`xdev-hive-${version}-linux-arm64.AppImage\` |

Bản build chưa có chứng chỉ ký của Apple/Microsoft:
- **macOS**: lần đầu mở, macOS chặn. Vào *System Settings → Privacy & Security* bấm *Open Anyway*, hoặc chạy \`xattr -dr com.apple.quarantine "/Applications/xDev Hive.app"\`.
- **Windows**: SmartScreen hiện cảnh báo, bấm *More info → Run anyway*.
- **Ubuntu (khuyên dùng, tự cập nhật không hỏi mật khẩu)**: tải \`install-linux.sh\` và AppImage đúng kiến trúc, chạy \`sh install-linux.sh xdev-hive-${version}-linux-x86_64.AppImage\`. App cài vào \`~/.local/share/xdev-hive\`, không cần sudo hay FUSE; mỗi lần cập nhật app tự đổi bản và mở lại. Đang dùng bản .deb: thoát app, chạy lệnh trên, rồi \`sudo apt remove xdev-hive\` (cấu hình và dữ liệu giữ nguyên).
- **Ubuntu/Debian (.deb)**: \`sudo apt install ./xdev-hive-${version}-linux-amd64.deb\` (ARM64: đổi amd64 thành arm64). Cập nhật trong app tải và kiểm SHA-256, rồi hỏi mật khẩu máy một lần và tự mở lại bản mới.
- **Ubuntu 22.04–26.04 AppImage**: cần FUSE 2 để chạy; cài \`libfuse2\` (Ubuntu 22.04/23.10) hoặc \`libfuse2t64\` (Ubuntu 24.04 trở lên). Sau đó chạy \`chmod +x xdev-hive-*.AppImage\` rồi \`./xdev-hive-*.AppImage\`. Nếu không có FUSE, có thể giải nén bằng \`./xdev-hive-*.AppImage --appimage-extract\` rồi chạy \`./squashfs-root/AppRun\`.

Kiểm tra file: \`SHA256SUMS.txt\`.

${whatsNew}
`;
const notesFile = path.join(release, "NOTES.md");
writeFileSync(notesFile, notes);
// The commit that was built, not main as it is by now: another session may have pushed while this one built.
if (!hubOnly) run("gh", ["release", "create", tag, ...assets, installScript, sumsFile, "--target", out("git", ["rev-parse", "HEAD"]), "--title", `xDev Hive ${tag}`, "--notes-file", notesFile], { cwd: repoRoot });
if (!hubOnly) run("gh", ["release", "edit", tag, "--notes-file", notesFile], { cwd: repoRoot });
await toHub(notes);
