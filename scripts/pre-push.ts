/**
 * Kiểm tra trước khi push (hook .githooks/pre-push): chỉ chạy phần bị ảnh hưởng so với origin/main để nhanh.
 * - Biome trên file đổi; typecheck và test các package bị ảnh hưởng (turbo --affected, base origin/main).
 * - Ranh giới module (pnpm deps).
 * - Đổi packages/contracts: openapi.json phải khớp (CI cũng kiểm).
 * - Đổi worker/: gofmt, go vet, go test.
 * Test DB của hub cần Docker; trên macOS dùng Colima thì tự đặt biến như AGENTS.md hướng dẫn.
 * Bản đầy đủ sát CI (build, Playwright, E2E smoke, cargo) là `pnpm ci:local`, chạy trước khi commit.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const base = process.env.HIVE_PREPUSH_BASE ?? "origin/main";

function changed(): string[] {
  const out = spawnSync("git", ["diff", "--name-only", `${base}...HEAD`], { cwd: root, encoding: "utf8" });
  return out.status === 0 ? out.stdout.split("\n").filter(Boolean) : [];
}

function run(label: string, cmd: string, args: string[], cwd = root, env: NodeJS.ProcessEnv = process.env): void {
  console.log(`\n▶ ${label}`);
  const r = spawnSync(cmd, args, { cwd, env, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`\n✗ ${label} lỗi. Sửa rồi push lại (bỏ qua một lần: git push --no-verify).`);
    process.exit(r.status ?? 1);
  }
}

const files = changed();
if (files.length === 0) {
  console.log("pre-push: không có thay đổi so với", base);
  process.exit(0);
}

// Git chạy hook với GIT_DIR, GIT_INDEX_FILE… trỏ vào repo này. Test nào gọi `git init --bare` hay `git config` mà thừa
// hưởng các biến đó sẽ sửa thẳng repo đang push (từng làm core.bare = true, hỏng mọi worktree). Bỏ hết GIT_* trước khi
// chạy lệnh con.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}
const env: NodeJS.ProcessEnv = { ...process.env, TURBO_SCM_BASE: base };
const colima = join(homedir(), ".colima/default/docker.sock");
if (!env.DOCKER_HOST && existsSync(colima)) {
  env.DOCKER_HOST = `unix://${colima}`;
  env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE ??= "/var/run/docker.sock";
}

const web = files.filter((f) => /\.(ts|tsx|js|mjs|cjs|json|jsonc|css)$/.test(f) && existsSync(join(root, f)));
if (web.length) run("biome (file đổi)", "pnpm", ["exec", "biome", "check", "--no-errors-on-unmatched", ...web]);

if (files.some((f) => /^(xdev-skills(?:\/|$)|\.gitmodules$|packages\/skill-pack\/)/.test(f)))
  run("bộ skill khớp submodule", "node", ["packages/skill-pack/scripts/sync.ts", "check"]);

const ts = files.some((f) => /^(apps|packages|scripts)\//.test(f) && !f.startsWith("apps/desktop/src-tauri/"));
if (ts) {
  run(
    "typecheck + test (package bị ảnh hưởng)",
    "pnpm",
    ["exec", "turbo", "run", "typecheck", "test", "--affected"],
    root,
    env,
  );
  run("ranh giới module", "pnpm", ["deps"]);
}

if (files.some((f) => f.startsWith("packages/contracts/"))) {
  run("openapi", "pnpm", ["openapi"]);
  run("openapi.json đã commit", "git", ["diff", "--exit-code", "--", "packages/contracts/openapi.json"]);
}

if (files.some((f) => f.startsWith("worker/"))) {
  const worker = join(root, "worker");
  const fmt = spawnSync("gofmt", ["-l", "."], { cwd: worker, encoding: "utf8" });
  if (fmt.stdout.trim()) {
    console.error(`\n✗ gofmt: chưa format\n${fmt.stdout}`);
    process.exit(1);
  }
  run("go vet", "go", ["vet", "./..."], worker);
  // CI chạy worker trên Windows: vet chéo bắt lỗi biên dịch của file _windows.go mà máy Mac/Linux không dựng.
  run("go vet (GOOS=windows)", "go", ["vet", "./..."], worker, { ...env, GOOS: "windows" });
  run("go test", "go", ["test", "./..."], worker);
}

console.log("\n✓ pre-push: kiểm tra xong (bản đầy đủ như CI: pnpm ci:local)");
