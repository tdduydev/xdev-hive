/**
 * `pnpm ci:local`: chạy tại máy đúng các bước của .github/workflows/ci.yml cho phần bị ảnh hưởng, để agent chạy TRƯỚC KHI
 * COMMIT. Hook pre-push chỉ chạy bản nhanh; bản này chạy thêm build, Playwright, E2E smoke, vet Windows, cargo.
 *
 * File đổi = khác biệt so với base (mặc định origin/main) + thay đổi chưa commit + file mới chưa track: agent chạy trước
 * khi commit nên phải tính cả phần chưa commit (turbo --affected chỉ so commit).
 *
 *   pnpm ci:local               phần bị ảnh hưởng
 *   pnpm ci:local --all         mọi bước như CI
 *   pnpm ci:local --plan        chỉ in các bước sẽ chạy
 *   pnpm ci:local --fail-fast   dừng ở bước hỏng đầu tiên (mặc định chạy hết rồi báo tổng)
 *   pnpm ci:local --base <ref>  so với ref khác origin/main
 *
 * Không chạy ở máy: job Docker image (trừ khi Dockerfile đổi) và E2E sandbox khi máy không có gVisor (mã 77 = bỏ qua).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const baseArg = args.indexOf("--base");
const base = (baseArg >= 0 ? args[baseArg + 1] : undefined) ?? "origin/main";
const all = flag("--all");
const planOnly = flag("--plan");
const failFast = flag("--fail-fast");

// Như pre-push: test gọi `git init`/`git config` mà thừa hưởng GIT_DIR… của hook sẽ sửa thẳng repo này.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}
const env: NodeJS.ProcessEnv = { ...process.env };
const colima = join(homedir(), ".colima/default/docker.sock");
if (!env.DOCKER_HOST && existsSync(colima)) {
  env.DOCKER_HOST = `unix://${colima}`;
  env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE ??= "/var/run/docker.sock";
}

function git(...a: string[]): string[] | null {
  const r = spawnSync("git", a, { cwd: root, encoding: "utf8" });
  return r.status === 0 ? r.stdout.split("\n").filter(Boolean) : null;
}

function changedFiles(): string[] | null {
  const committed = git("diff", "--name-only", `${base}...HEAD`);
  // Không có base (clone nông, chưa fetch): không biết phần nào đổi thì chạy hết.
  if (committed === null) return null;
  const local = git("diff", "--name-only", "HEAD") ?? [];
  const untracked = git("ls-files", "--others", "--exclude-standard") ?? [];
  return [...new Set([...committed, ...local, ...untracked])].sort();
}

const files = all ? null : changedFiles();
const everything = files === null;
const touched = (re: RegExp) => everything || files.some((f) => re.test(f));

// File ở gốc ảnh hưởng mọi package TypeScript (phụ thuộc, cấu hình chung, workflow CI).
const ROOT_WIDE =
  /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|tsconfig\.base\.json|biome\.json|\.nvmrc|\.dependency-cruiser\.cjs|\.github\/workflows\/ci\.yml)$/;

function workspacePackages(): { dir: string; name: string }[] {
  const out: { dir: string; name: string }[] = [];
  for (const group of ["apps", "packages"]) {
    for (const d of readdirSync(join(root, group))) {
      const pkg = join(root, group, d, "package.json");
      if (existsSync(pkg)) out.push({ dir: `${group}/${d}/`, name: JSON.parse(readFileSync(pkg, "utf8")).name });
    }
  }
  return out;
}

/** Bộ lọc turbo cho package bị ảnh hưởng và package phụ thuộc vào chúng; null là mọi package, [] là không package nào. */
function turboFilters(): string[] | null {
  if (everything || files.some((f) => ROOT_WIDE.test(f))) return null;
  const pkgs = workspacePackages().filter((p) => files.some((f) => f.startsWith(p.dir)));
  // src-tauri là Rust, không có task TypeScript nào.
  const ts = pkgs.filter(
    (p) => p.dir !== "apps/desktop/" || files.some((f) => /^apps\/desktop\/(?!src-tauri\/)/.test(f)),
  );
  return ts.map((p) => `--filter=...${p.name}`);
}

// ---- Playwright: file đổi → spec ---------------------------------------------------------------------------------

const E2E_DIR = join(root, "apps/web/e2e");
// Đổi những chỗ này thì mọi màn đều có thể vỡ: chạy đủ bộ.
const E2E_ALL =
  /^(packages\/(ui|contracts|doc-editor|code-review)\/|apps\/web\/(src\/(shell|components|hooks|lib|router\.tsx|main\.tsx|styles\.css)|e2e\/(fake-hub|[^/]*fixture)[^/]*\.ts|playwright\.config\.ts|vite\.config\.ts|index\.html|package\.json)|pnpm-lock\.yaml)/;
const NOISE = new Set([
  "page",
  "pages",
  "tab",
  "tsx",
  "ts",
  "src",
  "common",
  "text",
  "section",
  "card",
  "config",
  "web",
]);

function e2eSpecs(): string[] | null {
  const specs = readdirSync(E2E_DIR).filter((f) => f.endsWith(".spec.ts"));
  if (everything) return null;
  const web = files.filter(
    (f) => f.startsWith("apps/web/") || /^packages\/(ui|contracts|doc-editor|code-review)\//.test(f),
  );
  if (web.length === 0) return [];
  if (web.some((f) => E2E_ALL.test(f))) return null;
  const picked = new Set<string>();
  for (const f of web) {
    if (/^apps\/web\/e2e\/[^/]+\.spec\.ts$/.test(f)) {
      if (existsSync(join(root, f))) picked.add(f.slice("apps/web/e2e/".length));
      continue;
    }
    // Test vitest và file không phải giao diện không cần Playwright.
    if (!f.startsWith("apps/web/src/") || /\.test\.tsx?$/.test(f)) continue;
    if (!f.startsWith("apps/web/src/pages/")) return null;
    const tokens = f
      .slice("apps/web/src/pages/".length)
      .split(/[/.-]/)
      .filter((t) => t && !NOISE.has(t));
    const hits = specs.filter((s) =>
      s
        .replace(/\.spec\.ts$/, "")
        .split("-")
        .some((t) => tokens.includes(t)),
    );
    // Màn chưa có spec đặt tên theo nó: không đoán được spec nào phủ, chạy đủ bộ.
    if (hits.length === 0) return null;
    for (const h of hits) picked.add(h);
  }
  return [...picked].sort();
}

// ---- Các bước ------------------------------------------------------------------------------------------------------

type Step = { label: string; run: () => number };
const steps: Step[] = [];

function cmd(label: string, command: string, a: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  steps.push({
    label,
    run: () => spawnSync(command, a, { cwd: opts.cwd ?? root, env: opts.env ?? env, stdio: "inherit" }).status ?? 1,
  });
}

const fileHash = (p: string) => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "");

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

function dockerReady(): boolean {
  return spawnSync("docker", ["info"], { env, stdio: "ignore" }).status === 0;
}

const filters = turboFilters();
const tsAffected = filters === null || filters.length > 0;
const scriptsTouched = touched(/^scripts\/.*\.ts$/) || touched(ROOT_WIDE);
const specs = e2eSpecs();
const hubTouched = touched(/^(apps\/hub|packages\/contracts)\//) || touched(ROOT_WIDE);
const workerTouched = touched(/^worker\//) || touched(/^\.github\/workflows\/ci\.yml$/);

if (touched(/^(xdev-skills(?:\/|$)|\.gitmodules$|packages\/skill-pack\/)/) || touched(ROOT_WIDE))
  cmd("bộ skill khớp submodule", "node", ["packages/skill-pack/scripts/sync.ts", "check"]);

if (touched(/\.(ts|tsx|js|mjs|cjs|json|jsonc|css)$/) || touched(ROOT_WIDE)) cmd("lint (biome)", "pnpm", ["lint"]);

if (tsAffected) {
  const f = filters ?? [];
  cmd("typecheck", "pnpm", ["exec", "turbo", "run", "typecheck", ...f]);
}
if (scriptsTouched) cmd("typecheck scripts", "pnpm", ["exec", "tsc", "-p", "scripts"]);
if (tsAffected || scriptsTouched) cmd("ranh giới module (deps)", "pnpm", ["deps"]);

if (tsAffected) {
  const f = filters ?? [];
  // CI chạy cả test có database; thiếu Docker thì báo hỏng chứ không bỏ qua, kẻo xanh ở máy mà đỏ trên CI.
  if (hubTouched || filters === null) {
    steps.push({
      label: "Docker cho test có database",
      run: () => {
        if (dockerReady()) return 0;
        console.error("Không nối được Docker. Bật Docker/Colima (colima start) rồi chạy lại.");
        return 1;
      },
    });
  }
  // Không đọc cache của turbo: test chập chờn từng xanh một lần sẽ được "phát lại" xanh mãi, còn CI chạy lại thật.
  cmd("test (vitest, có database)", "pnpm", ["exec", "turbo", "run", "test", "--cache=local:w", ...f]);
  cmd("build", "pnpm", ["exec", "turbo", "run", "build", ...f]);
}

if (touched(/^packages\/contracts\//)) {
  const spec = join(root, "packages/contracts/openapi.json");
  steps.push({
    label: "openapi.json khớp hợp đồng",
    run: () => {
      const before = fileHash(spec);
      const status = spawnSync("pnpm", ["openapi"], { cwd: root, env, stdio: "inherit" }).status ?? 1;
      if (status !== 0) return status;
      if (fileHash(spec) === before) return 0;
      console.error("openapi.json vừa được sinh lại khác bản trong cây làm việc: xem lại rồi commit nó.");
      return 1;
    },
  });
}

if (specs === null || specs.length > 0) {
  steps.push({
    label: specs === null ? "Playwright (đủ bộ)" : `Playwright (${specs.join(", ")})`,
    run: () => {
      const web = join(root, "apps/web");
      const install = spawnSync("pnpm", ["exec", "playwright", "install", "chromium"], {
        cwd: web,
        env,
        stdio: "inherit",
      });
      if (install.status !== 0) return install.status ?? 1;
      // Cổng riêng: không dùng lại Vite của worktree khác đang giữ cổng mặc định (code khác, test hỏng ngẫu nhiên).
      const port = String(portForE2e);
      const r = spawnSync("pnpm", ["exec", "playwright", "test", ...(specs ?? []).map((s) => `e2e/${s}`)], {
        cwd: web,
        env: { ...env, HIVE_WEB_E2E_PORT: port, CI: "1" },
        stdio: "inherit",
      });
      return r.status ?? 1;
    },
  });
}

if (workerTouched) {
  const worker = join(root, "worker");
  steps.push({
    label: "gofmt",
    run: () => {
      const out = spawnSync("gofmt", ["-l", "."], { cwd: worker, encoding: "utf8" });
      if (out.status !== 0) return out.status ?? 1;
      if (!out.stdout.trim()) return 0;
      console.error(`Chưa gofmt:\n${out.stdout}`);
      return 1;
    },
  });
  cmd("go vet", "go", ["vet", "./..."], { cwd: worker });
  // CI chạy worker trên cả Windows; vet chéo bắt lỗi biên dịch của file _windows.go mà máy Mac/Linux không dựng.
  cmd("go vet (GOOS=windows)", "go", ["vet", "./..."], { cwd: worker, env: { ...env, GOOS: "windows" } });
  cmd("go vet (GOOS=linux)", "go", ["vet", "./..."], { cwd: worker, env: { ...env, GOOS: "linux" } });
  // -count=1: như vitest ở trên, không dùng kết quả cache của lần chạy xanh trước.
  cmd("go test", "go", ["test", "-count=1", "./..."], { cwd: worker });
  cmd("go build hive-worker", "go", ["build", "-o", "bin/", "./cmd/hive-worker"], { cwd: worker });
  if (touched(/^scripts\/install\.sh$/) && spawnSync("shellcheck", ["--version"], { stdio: "ignore" }).status === 0) {
    cmd("shellcheck install.sh", "shellcheck", ["-s", "sh", "scripts/install.sh"]);
  }
}

// Job E2E của CI: hub và worker thật, Postgres qua Testcontainers.
if (touched(/^(apps\/hub|worker|packages\/contracts)\/|^scripts\/e2e-/)) {
  cmd("E2E smoke", "pnpm", ["e2e:smoke"]);
  steps.push({
    label: "E2E sandbox (gVisor)",
    run: () => {
      const r = spawnSync("pnpm", ["e2e:sandbox"], { cwd: root, env, stdio: "inherit" }).status ?? 1;
      // 77: máy không có Docker + runsc (macOS): CI vẫn chạy bước này.
      if (r === 77) skipped.push("E2E sandbox (máy không có gVisor; CI vẫn chạy)");
      return r === 77 ? 0 : r;
    },
  });
}

if (touched(/^apps\/desktop\/src-tauri\//)) {
  cmd("dựng giao diện app", "node", ["apps/desktop/scripts/build-frontend.ts"]);
  cmd("dựng sidecar hive-worker", "node", ["apps/desktop/scripts/build-sidecar.ts"]);
  const tauri = join(root, "apps/desktop/src-tauri");
  cmd("cargo check", "cargo", ["check", "--locked"], { cwd: tauri });
  cmd("cargo test", "cargo", ["test", "--locked"], { cwd: tauri });
}

if (!everything && files.some((f) => f === "Dockerfile" || f === ".dockerignore")) {
  cmd("docker build", "docker", ["build", "-t", "xdev-hive:ci-local", "."]);
}

// ---- Chạy --------------------------------------------------------------------------------------------------------

const skipped: string[] = [];
const portForE2e = await freePort();

console.log(
  everything
    ? `ci:local: chạy mọi bước${all ? " (--all)" : ` (không so được với ${base})`}`
    : `ci:local: ${files.length} file đổi so với ${base} (gồm cả chưa commit)`,
);
for (const s of steps) console.log(`  • ${s.label}`);
if (steps.length === 0) {
  console.log("Không có bước nào bị ảnh hưởng.");
  process.exit(0);
}
if (planOnly) process.exit(0);

const results: { label: string; ok: boolean; sec: number }[] = [];
for (const s of steps) {
  console.log(`\n▶ ${s.label}`);
  const t = Date.now();
  const ok = s.run() === 0;
  results.push({ label: s.label, ok, sec: Math.round((Date.now() - t) / 1000) });
  if (!ok) {
    console.error(`✗ ${s.label} hỏng`);
    if (failFast) break;
  }
}

console.log("\nci:local: kết quả");
for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.label} (${r.sec}s)`);
for (const s of skipped) console.log(`  - bỏ qua: ${s}`);
const failed = results.filter((r) => !r.ok);
if (failed.length || results.length < steps.length) {
  console.error(`\n✗ ci:local: ${failed.length} bước hỏng. Sửa rồi chạy lại trước khi commit.`);
  process.exit(1);
}
console.log("\n✓ ci:local: xanh");
