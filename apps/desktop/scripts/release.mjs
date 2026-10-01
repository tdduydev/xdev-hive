// Builds the desktop app for every platform on this Mac and publishes a GitHub release (no CI).
//   npm run release -w @xdev-hive/desktop            (version from package.json, tag v<version>)
//   npm run release -w @xdev-hive/desktop -- --dry   (build and list the files, publish nothing)
//   npm run release -w @xdev-hive/desktop -- --hub-only   (skip GitHub: upload the built files to the hub again)
// Needs: a clean checkout of origin/main, `gh` signed in with push access. macOS builds are ad-hoc
// signed (no Developer ID yet); Windows installers are unsigned.
// With HIVE_RELEASE_HUB (https://hive.example) and HIVE_RELEASE_TOKEN (a hub admin's token) the builds also go to the
// hub, which hands them to machines as updates (roadmap 22i; admins pick the version on Phiên bản app).
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(desktop, "..", "..");
const release = path.join(desktop, "release");
const dry = process.argv.includes("--dry");
const hubOnly = process.argv.includes("--hub-only");
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
  // One installer per architecture (a combined one would double the download).
  builder("--win", "--x64");
  builder("--win", "--arm64");
  builder("--linux", "--x64", "--arm64");
}

const assets = readdirSync(release)
  .filter((f) => /\.(dmg|zip|exe|AppImage)$/.test(f))
  .sort()
  .map((f) => path.join(release, f));
const sums = assets.map((f) => `${createHash("sha256").update(readFileSync(f)).digest("hex")}  ${path.basename(f)}`).join("\n");
const sumsFile = path.join(release, "SHA256SUMS.txt");
writeFileSync(sumsFile, `${sums}\n`);
for (const f of assets) console.log(`${(statSync(f).size / 1e6).toFixed(0).padStart(5)} MB  ${path.basename(f)}`);

if (dry) {
  console.log(`\n--dry: nothing published (${tag}).`);
  process.exit(0);
}

/** platform, arch and kind from electron-builder's file names (see artifactName in electron-builder.yml). */
function describe(name) {
  const m = /-(mac|win|linux)-(arm64|x64|x86_64)(?:-setup)?\.(dmg|zip|exe|AppImage)$/.exec(name);
  return m ? { platform: m[1], arch: m[2] === "x86_64" ? "x64" : m[2], kind: m[3] } : null;
}

/** Uploads every build and the notes to the hub, when HIVE_RELEASE_HUB and HIVE_RELEASE_TOKEN say where. */
async function toHub(notes) {
  const hub = process.env.HIVE_RELEASE_HUB?.replace(/\/+$/, "");
  const token = process.env.HIVE_RELEASE_TOKEN;
  if (!hub || !token) {
    console.log("HIVE_RELEASE_HUB / HIVE_RELEASE_TOKEN not set: the hub does not get this release.");
    return;
  }
  const headers = { authorization: `Bearer ${token}` };
  // A proxy in front of the hub may refuse big bodies (Cloudflare: 100 MB): bigger builds go in parts, which only a
  // hub that says how big a part may be takes (an older one would keep the first part as the whole build).
  const listed = await fetch(`${hub}/api/rpc`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ method: "releases.list" }) });
  if (!listed.ok) throw new Error(`hub releases.list: HTTP ${listed.status} ${await listed.text()}`);
  const list = (await listed.json()).result;
  const partBytes = list?.uploadPart ?? null;
  // A --hub-only run after a cut-off one sends only what the hub does not have yet (same name and bytes).
  const have = new Set((list?.releases ?? []).filter((r) => r.version === version).flatMap((r) => r.files ?? []).map((f) => `${f.name} ${f.sha256}`));
  const send = async (q, body, what) => {
    const res = await fetch(`${hub}/api/releases/upload?${q}`, { method: "POST", headers: { ...headers, "content-type": "application/octet-stream" }, body, duplex: "half" });
    if (!res.ok) throw Object.assign(new Error(`hub upload ${what}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`), { status: res.status });
  };
  const sendFile = async (file, name, size, q) => {
    if (!partBytes || size <= partBytes) return send(new URLSearchParams(q), createReadStream(file), name);
    const parts = Math.ceil(size / partBytes);
    const upload = randomBytes(16).toString("hex");
    for (let part = 0; part < parts; part++) {
      const start = part * partBytes;
      const body = createReadStream(file, { start, end: Math.min(size, start + partBytes) - 1 });
      await send(new URLSearchParams({ ...q, upload, part: String(part), parts: String(parts) }), body, `${name} part ${part + 1}/${parts}`);
    }
  };
  for (const file of assets) {
    const name = path.basename(file);
    const d = describe(name);
    if (!d) continue;
    const size = statSync(file).size;
    const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
    const q = { version, channel: "stable", name, sha256, ...d };
    if (have.has(`${name} ${sha256}`)) {
      console.log(`hub = ${name} (already there)`);
      continue;
    }
    // The tunnel in front of the hub sometimes cuts a body off (the hub logs "aborted"), and the hub then drops the
    // whole upload: the file goes again from its first part, twice at most.
    for (let attempt = 1; ; attempt++) {
      try {
        await sendFile(file, name, size, q);
        break;
      } catch (err) {
        if (attempt === 3 || !(err instanceof TypeError || err.status >= 500 || err.status === 409)) throw err;
        console.log(`hub: ${name} cut off (${err.cause?.code ?? err.message}), sending it again (${attempt + 1}/3)`);
        await new Promise((r) => setTimeout(r, 5000 * attempt));
      }
    }
    console.log(`hub ← ${name}`);
  }
  const res = await fetch(`${hub}/api/rpc`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ method: "releases.notes", input: { version, notes } }) });
  if (!res.ok) throw new Error(`hub notes: HTTP ${res.status}`);
  console.log(`hub has ${version}: pick it on Phiên bản app to roll it out.`);
}

// The tag before this one (a --hub-only run comes after this version's tag exists).
const previous = out("git", ["tag", "--list", "v*", "--sort=-v:refname"]).split("\n").filter((t) => t && t !== tag)[0];
const changes = out("git", ["log", "--first-parent", "--format=- %s", previous ? `${previous}..HEAD` : "HEAD", "--", "."])
  .split("\n")
  .filter((l) => l && !l.startsWith("- Merge branch"))
  .slice(0, 40)
  .join("\n");
const notes = `## Tải về

| Máy | File |
|---|---|
| macOS Apple Silicon (M1…) | \`xdev-hive-${version}-mac-arm64.dmg\` |
| macOS Intel | \`xdev-hive-${version}-mac-x64.dmg\` |
| Windows x64 | \`xdev-hive-${version}-win-x64-setup.exe\` |
| Windows ARM | \`xdev-hive-${version}-win-arm64-setup.exe\` |
| Linux x64 | \`xdev-hive-${version}-linux-x86_64.AppImage\` |
| Linux ARM64 | \`xdev-hive-${version}-linux-arm64.AppImage\` |

Bản build chưa có chứng chỉ ký của Apple/Microsoft:
- **macOS**: lần đầu mở, macOS chặn. Vào *System Settings → Privacy & Security* bấm *Open Anyway*, hoặc chạy \`xattr -dr com.apple.quarantine "/Applications/xDev Hive.app"\`.
- **Windows**: SmartScreen hiện cảnh báo, bấm *More info → Run anyway*.
- **Linux**: \`chmod +x xdev-hive-*.AppImage\` rồi chạy.

Kiểm tra file: \`SHA256SUMS.txt\`.

## Thay đổi
${changes || "- (không có)"}
`;
const notesFile = path.join(release, "NOTES.md");
writeFileSync(notesFile, notes);
if (!hubOnly) run("gh", ["release", "create", tag, ...assets, sumsFile, "--target", "main", "--title", `xDev Hive ${tag}`, "--notes-file", notesFile], { cwd: repoRoot });
await toHub(notes);
