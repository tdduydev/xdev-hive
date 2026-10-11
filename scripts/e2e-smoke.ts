// Chạy thử trọn luồng của xDev Hive qua API công khai, như người dùng thật: Postgres → hub → đăng ký → tổ chức, đội,
// hệ thống → kết nối Git → dự án → worker → task, run → PR. Chạy: `pnpm e2e:smoke`.
//
// Mặc định không ra mạng ngoài: Git là bare repo trong thư mục tạm (provider "local" của module scm, chỉ bật khi hub
// chạy với HIVE_E2E=1), agent là CLI giả scripts/e2e-fake-cli.ts. Biến môi trường:
//   HIVE_E2E_DATABASE_ADMIN_URL  Postgres có sẵn (superuser) thay cho Testcontainers. Bootstrap đổi mật khẩu các role
//                                hive_*: đặt HIVE_DB_OWNER_PASSWORD, HIVE_DB_APP_PASSWORD, HIVE_DB_AUTH_PASSWORD,
//                                HIVE_DB_JOBS_PASSWORD trùng .env nếu dùng chung với hub dev.
//   HIVE_TEST_POSTGRES_IMAGE     Image Postgres cho Testcontainers (mặc định như test của hub).
//   HIVE_E2E_GITHUB=1            Dùng GitHub thật: HIVE_E2E_GITHUB_TOKEN (PAT tạo được repo), HIVE_E2E_GITHUB_OWNER.
//   HIVE_E2E_CLEANUP=1           Cuối script xoá repo GitHub đã tạo (token cần quyền xoá repo).
//   HIVE_E2E_REAL_CLI=1          Dùng CLI thật trên máy thay cho CLI giả; HIVE_E2E_CLI chọn claude|codex|gemini.
//   HIVE_E2E_RUN_TIMEOUT_SEC     Thời gian chờ run kết thúc (mặc định 300).
//   HIVE_E2E_VERBOSE=1           In log của hub và worker trong lúc chạy (mặc định chỉ in khi có bước không đạt).
//   HIVE_E2E_KEEP=1              Giữ thư mục tạm để xem lại.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  MyOrg,
  Project,
  ProjectCreateInput,
  ProjectCreateResult,
  ProvisionView,
  Run,
  RunEventView,
  RunLogChunk,
  ScmConnection,
  ScmConnectionCreateInput,
  ScmConnectionTestResult,
  System,
  Task,
  Team,
} from "../packages/contracts/src/index.ts";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const env = process.env;
const GITHUB = env.HIVE_E2E_GITHUB === "1";
const REAL_CLI = env.HIVE_E2E_REAL_CLI === "1";
const CLEANUP = env.HIVE_E2E_CLEANUP === "1";
const VERBOSE = env.HIVE_E2E_VERBOSE === "1";
const KEEP = env.HIVE_E2E_KEEP === "1";
const CLI = (env.HIVE_E2E_CLI ?? "claude") as "claude" | "codex" | "gemini";
const RUN_TIMEOUT_MS = Number(env.HIVE_E2E_RUN_TIMEOUT_SEC ?? 300) * 1000;
const POSTGRES_IMAGE = env.HIVE_TEST_POSTGRES_IMAGE ?? "pgvector/pgvector:0.8.7-pg18-trixie";
// Kết nối GitLab trỏ vào host này được hub (HIVE_E2E=1) chuyển sang provider local; xem apps/hub/src/modules/scm/local.ts.
const LOCAL_SCM_URL = "https://hive-e2e.invalid";
const LOCAL_OWNER = "e2e";
const GITHUB_API = "https://api.github.com";
const isWindows = process.platform === "win32";

// Tên duy nhất theo thời gian: chạy lại trên cùng database hay cùng owner GitHub không đụng lần trước.
const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const names = {
  email: `e2e-${stamp}@example.com`,
  org: `e2e-${stamp}`,
  projectKey: `e2e${stamp}`,
  repo: `hive-e2e-${stamp}`,
  machine: `e2e-${stamp}`,
};

// ---- Bước và bảng tóm tắt ----------------------------------------------------------------------------------------

type Status = "đạt" | "không đạt" | "chờ" | "bỏ qua";
interface StepResult {
  name: string;
  status: Status;
  ms: number;
  note?: string;
}

const STEPS = {
  db: "1. Postgres, bootstrap, migrate",
  hub: "2. Hub chạy, /api/v1/health",
  tenant: "3. Đăng ký, tổ chức, đội, hệ thống",
  scm: `4. Kết nối Git (${GITHUB ? "GitHub" : "local"})`,
  project: "5. Dự án mới, provision tới active",
  worker: "6. Worker: build, đăng ký, online",
  run: "7. Task, run, theo dõi SSE",
  succeeded: "8a. Run succeeded",
  review: "8b. Task sang review",
  pr: "8c. PR tồn tại",
  report: "8d. Agent báo cáo qua MCP",
  worktree: "8e. Worktree trên worker đã gỡ",
  cleanup: "9. Dọn dẹp",
} as const;
type StepKey = keyof typeof STEPS;

const results = new Map<StepKey, StepResult>();

/** Dừng luồng chính; các bước sau ghi "bỏ qua" (bước trước hỏng) hoặc "chờ" (chưa có tính năng). */
class StopFlow extends Error {}
/** Hệ thống chưa có tính năng cho bước này (không phải lỗi): các bước phụ thuộc ghi "chờ". */
class Pending extends Error {}
/** Ném trong probe của waitFor để dừng chờ ngay (lỗi thật, không phải chưa sẵn sàng). */
class GiveUp extends Error {}
let stopReason: { status: "bỏ qua" | "chờ"; note: string } | null = null;

const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function timed<T>(key: StepKey, fn: () => Promise<T>): Promise<{ value?: T; error?: unknown }> {
  const name = STEPS[key];
  console.log(`\n▶ ${name}`);
  const t0 = performance.now();
  try {
    const value = await fn();
    const ms = performance.now() - t0;
    results.set(key, { name, status: "đạt", ms });
    console.log(`  ✓ đạt (${fmtMs(ms)})`);
    return { value };
  } catch (error) {
    const ms = performance.now() - t0;
    const status: Status = error instanceof Pending ? "chờ" : "không đạt";
    results.set(key, { name, status, ms, note: errText(error) });
    console.log(`  ${status === "chờ" ? "⏸ chờ" : "✗ không đạt"} (${fmtMs(ms)}): ${errText(error)}`);
    return { error };
  }
}

/** Bước của luồng chính: hỏng thì dừng luồng. */
async function step<T>(key: StepKey, fn: () => Promise<T>): Promise<T> {
  const { value, error } = await timed(key, fn);
  if (error === undefined) return value as T;
  stopReason =
    error instanceof Pending
      ? { status: "chờ", note: errText(error) }
      : { status: "bỏ qua", note: `bước trước không đạt` };
  throw new StopFlow();
}

/** Bước kiểm tra độc lập: hỏng vẫn chạy các kiểm tra khác. */
async function check(key: StepKey, fn: () => Promise<void>): Promise<void> {
  await timed(key, fn);
}

function skip(key: StepKey, status: "bỏ qua" | "chờ", note: string) {
  if (!results.has(key)) results.set(key, { name: STEPS[key], status, ms: 0, note });
}

function printSummary() {
  const rows = (Object.keys(STEPS) as StepKey[]).map(
    (k) => results.get(k) ?? { name: STEPS[k], status: "bỏ qua" as Status, ms: 0, note: "không chạy" },
  );
  const w = Math.max(...rows.map((r) => r.name.length));
  console.log("\n══ Tóm tắt e2e-smoke ══");
  console.log(`${"Bước".padEnd(w)}  ${"Kết quả".padEnd(10)}  ${"Thời gian".padStart(9)}  Ghi chú`);
  for (const r of rows) {
    const time = r.ms ? fmtMs(r.ms) : "-";
    const note = (r.note ?? "").split("\n")[0]?.slice(0, 160) ?? "";
    console.log(`${r.name.padEnd(w)}  ${r.status.padEnd(10)}  ${time.padStart(9)}  ${note}`);
  }
  const total = rows.reduce((s, r) => s + r.ms, 0);
  const failed = rows.filter((r) => r.status === "không đạt").length;
  const pending = rows.filter((r) => r.status === "chờ").length;
  console.log(
    `\nTổng ${fmtMs(total)}: ${failed ? `${failed} bước không đạt` : "không bước nào hỏng"}${pending ? `, ${pending} bước chờ` : ""}.`,
  );
  return failed;
}

// ---- Tiện ích ------------------------------------------------------------------------------------------------------

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined | null | false>,
  opts: { timeoutMs: number; intervalMs?: number; alive?: Proc | undefined },
): Promise<T> {
  const until = Date.now() + opts.timeoutMs;
  let last: unknown;
  while (Date.now() < until) {
    if (opts.alive?.exited) throw new Error(`${opts.alive.name} đã thoát (mã ${opts.alive.exitCode}) khi chờ ${what}`);
    try {
      const v = await probe();
      if (v) return v;
    } catch (e) {
      if (e instanceof GiveUp) throw new Error(e.message);
      last = e;
    }
    await delay(opts.intervalMs ?? 500);
  }
  throw new Error(`Hết ${fmtMs(opts.timeoutMs)} chờ ${what}${last ? `: ${errText(last)}` : ""}`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() =>
        typeof addr === "object" && addr ? resolve(addr.port) : reject(new Error("Không lấy được cổng")),
      );
    });
  });
}

const secret = () => randomBytes(24).toString("base64url");

/** Tiến trình con kèm file log; theo dõi được dòng log khớp mẫu. */
class Proc {
  readonly name: string;
  readonly child: ChildProcess;
  exited = false;
  exitCode: number | null = null;
  private readonly lines: string[] = [];
  private readonly watchers: Array<{ re: RegExp; resolve: (line: string) => void }> = [];
  private readonly done: Promise<void>;
  private readonly log: WriteStream;

  constructor(name: string, child: ChildProcess, logFile: string) {
    this.name = name;
    this.child = child;
    this.log = createWriteStream(logFile);
    let buf = "";
    const onData = (chunk: Buffer) => {
      this.log.write(chunk);
      buf += chunk.toString("utf8");
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const line of parts) this.onLine(line);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    this.done = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        this.exited = true;
        this.exitCode = code ?? (signal ? 128 : 1);
        if (buf) this.onLine(buf);
        this.log.end();
        resolve();
      });
    });
  }

  private onLine(line: string) {
    this.lines.push(line);
    if (this.lines.length > 400) this.lines.shift();
    if (VERBOSE) console.log(`  [${this.name}] ${line}`);
    for (const w of this.watchers) if (w.re.test(line)) w.resolve(line);
  }

  /** Resolve khi có dòng log khớp mẫu (kể cả dòng đã in trước đó). */
  waitForLine(re: RegExp): Promise<string> {
    const seen = this.lines.find((l) => re.test(l));
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve) => this.watchers.push({ re, resolve }));
  }

  tail(n = 60): string {
    return this.lines.slice(-n).join("\n");
  }

  /** SIGTERM để tiến trình dừng êm (hub nhả job pg-boss, worker đóng WSS), quá hạn thì kill. */
  async stop(graceMs = 10_000): Promise<void> {
    if (this.exited) return;
    this.child.kill("SIGTERM");
    const timedOut = await Promise.race([this.done.then(() => false), delay(graceMs).then(() => true)]);
    if (timedOut) {
      this.child.kill("SIGKILL");
      await this.done;
    }
  }
}

function startProc(
  name: string,
  cmd: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; cwd?: string; log: string },
) {
  const child = spawn(cmd, args, { cwd: opts.cwd ?? ROOT, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
  return new Proc(name, child, opts.log);
}

async function runCmd(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}) {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      cwd: opts.cwd ?? ROOT,
      env: opts.env ?? env,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message: string };
    throw new Error(`${cmd} ${args.join(" ")} lỗi: ${(err.stderr || err.stdout || err.message).trim().slice(-800)}`);
  }
}

/** Biến môi trường không có HIVE_*, để cấu hình của máy người chạy không lẫn vào hub và worker thử. */
function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("HIVE_")));
}

// ---- Client HTTP của hub (cookie phiên như trình duyệt) -------------------------------------------------------------

class HubClient {
  readonly base: string;
  private readonly cookies = new Map<string, string>();
  orgId: string | null = null;

  constructor(base: string) {
    this.base = base;
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { accept: "application/json", origin: this.base, ...extra };
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (this.orgId) h["x-hive-org"] = this.orgId;
    return h;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(new URL(path, this.base), {
      method,
      headers: this.headers(body === undefined ? {} : { "content-type": "application/json" }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const eq = pair?.indexOf("=") ?? -1;
      if (pair && eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}: ${text.slice(0, 600)}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  get<T>(path: string) {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body: unknown = {}) {
    return this.request<T>("POST", path, body);
  }
}

// ---- Trạng thái dùng chung giữa các bước và bước dọn dẹp -----------------------------------------------------------

const state: {
  tmp?: string | undefined;
  container?: { stop(): Promise<unknown> } | undefined;
  hub?: Proc | undefined;
  worker?: Proc | undefined;
  githubRepoTried?: boolean | undefined;
  workerDataDir?: string | undefined;
  repoUrl?: string | undefined;
} = {};

// ---- 1. Postgres ---------------------------------------------------------------------------------------------------

interface DbUrls {
  appUrl: string;
  authUrl: string;
  jobsUrl: string;
}

async function startPostgres(): Promise<DbUrls> {
  let adminUrl = env.HIVE_E2E_DATABASE_ADMIN_URL;
  if (adminUrl) {
    console.log("  Dùng Postgres có sẵn (HIVE_E2E_DATABASE_ADMIN_URL).");
  } else {
    console.log(`  Testcontainers: ${POSTGRES_IMAGE}`);
    // Nạp lúc cần: dùng Postgres có sẵn thì không cần Docker.
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    const container = await new PostgreSqlContainer(POSTGRES_IMAGE).withDatabase("hive").start();
    state.container = container;
    adminUrl = container.getConnectionUri();
  }
  const pw = {
    owner: env.HIVE_DB_OWNER_PASSWORD || secret(),
    app: env.HIVE_DB_APP_PASSWORD || secret(),
    auth: env.HIVE_DB_AUTH_PASSWORD || secret(),
    jobs: env.HIVE_DB_JOBS_PASSWORD || secret(),
  };
  const url = (user: string, password: string) => {
    const u = new URL(adminUrl);
    u.username = user;
    u.password = password;
    return u.toString();
  };
  // Đi qua CLI quản trị của hub như người vận hành, không gọi thẳng hàm trong code.
  const base = cleanEnv();
  console.log("  db:bootstrap");
  await runCmd(process.execPath, ["apps/hub/src/cli.ts", "db:bootstrap"], {
    env: {
      ...base,
      HIVE_DATABASE_ADMIN_URL: adminUrl,
      HIVE_DB_OWNER_PASSWORD: pw.owner,
      HIVE_DB_APP_PASSWORD: pw.app,
      HIVE_DB_AUTH_PASSWORD: pw.auth,
      HIVE_DB_JOBS_PASSWORD: pw.jobs,
    },
  });
  console.log("  db:migrate");
  await runCmd(process.execPath, ["apps/hub/src/cli.ts", "db:migrate"], {
    env: { ...base, HIVE_DATABASE_OWNER_URL: url("hive_owner", pw.owner) },
  });
  return { appUrl: url("hive_app", pw.app), authUrl: url("hive_auth", pw.auth), jobsUrl: url("hive_jobs", pw.jobs) };
}

// ---- 2. Hub --------------------------------------------------------------------------------------------------------

interface LocalGit {
  root: string;
  prDir: string;
}

async function startHub(db: DbUrls, tmp: string, localGit: LocalGit | null): Promise<HubClient> {
  const port = await freePort();
  // 127.0.0.1 là địa chỉ hub coi như localhost: bật được cổng /mcp mà không cần HTTPS.
  const url = `http://127.0.0.1:${port}`;
  const hubEnv: NodeJS.ProcessEnv = {
    ...cleanEnv(),
    HIVE_PORT: String(port),
    HIVE_PUBLIC_URL: url,
    HIVE_DATABASE_URL: db.appUrl,
    HIVE_DATABASE_AUTH_URL: db.authUrl,
    HIVE_DATABASE_JOBS_URL: db.jobsUrl,
    // Khoá chủ và secret sinh mới mỗi lần; mất sau khi chạy xong cũng không sao vì database bị bỏ.
    HIVE_MASTER_KEY: randomBytes(32).toString("base64"),
    HIVE_AUTH_SECRET: randomBytes(32).toString("base64url"),
    HIVE_ALLOW_EMAIL_SIGNUP: "1",
    // Database có sẵn có thể đã có tổ chức; cho người thử tạo thêm tổ chức.
    HIVE_ORG_CREATORS: names.email,
    ...(localGit ? { HIVE_E2E: "1", HIVE_E2E_GIT_ROOT: localGit.root, HIVE_E2E_PR_DIR: localGit.prDir } : {}),
  };
  console.log(`  node apps/hub/src/main.ts trên ${url}`);
  const hub = startProc("hub", process.execPath, ["apps/hub/src/main.ts"], { env: hubEnv, log: join(tmp, "hub.log") });
  state.hub = hub;
  const health = await waitFor(
    "hub trả /api/v1/health",
    async () => {
      const res = await fetch(`${url}/api/v1/health`);
      return res.ok ? ((await res.json()) as { version: string }) : null;
    },
    { timeoutMs: 60_000, alive: hub },
  );
  console.log(`  Hub ${health.version} sẵn sàng.`);
  return new HubClient(url);
}

// ---- 3. Người dùng, tổ chức, đội, hệ thống -------------------------------------------------------------------------

async function setupTenant(api: HubClient) {
  await api.post("/api/auth/sign-up/email", {
    name: "Người thử e2e",
    email: names.email,
    password: `${secret()}-Aa1`,
  });
  const me = await api.get<{ id: string; email: string }>("/api/v1/me");
  console.log(`  Đăng ký ${me.email}`);
  const org = await api.post<MyOrg>("/api/v1/orgs", { name: `Tổ chức thử ${stamp}`, slug: names.org });
  api.orgId = org.id;
  const team = await api.post<Team>("/api/v1/teams", { name: "Đội thử e2e", slug: "doi-e2e", adminUserId: me.id });
  const system = await api.post<System>("/api/v1/systems", { teamId: team.id, name: "Hệ thống e2e", slug: "he-e2e" });
  console.log(`  Tổ chức ${org.slug} (${org.role}), đội ${team.slug}, hệ thống ${system.slug}`);
  return { org, team, system };
}

// ---- 4. Kết nối Git ------------------------------------------------------------------------------------------------

function githubSettings() {
  const token = env.HIVE_E2E_GITHUB_TOKEN;
  const owner = env.HIVE_E2E_GITHUB_OWNER;
  if (!token || !owner) throw new Error("HIVE_E2E_GITHUB=1 cần HIVE_E2E_GITHUB_TOKEN và HIVE_E2E_GITHUB_OWNER.");
  return { token, owner };
}

async function connectGit(api: HubClient) {
  const input: ScmConnectionCreateInput = GITHUB
    ? {
        kind: "github",
        authMode: "token",
        name: "GitHub e2e",
        defaultOwner: githubSettings().owner,
        token: githubSettings().token,
      }
    : {
        kind: "gitlab",
        name: "Git cục bộ (chỉ để thử)",
        baseUrl: LOCAL_SCM_URL,
        defaultOwner: LOCAL_OWNER,
        // Provider local không dùng token; hợp đồng bắt buộc có nên gửi chuỗi giả.
        token: "e2e-local-khong-dung",
      };
  const conn = await api.post<ScmConnection>("/api/v1/scm-connections", input);
  const owner = conn.defaultOwner ?? LOCAL_OWNER;
  const test = await api.post<ScmConnectionTestResult>(`/api/v1/scm-connections/${conn.id}/test`, { owner });
  console.log(`  ${conn.kind} "${conn.name}": ${test.message}`);
  if (!test.ok || !test.canCreate) throw new Error(`Kết nối không tạo được repo trong ${owner}: ${test.message}`);
  return { conn, owner };
}

// ---- 5. Dự án ------------------------------------------------------------------------------------------------------

async function createProject(
  api: HubClient,
  systemId: string,
  connectionId: string,
  owner: string,
  localGit: LocalGit | null,
) {
  const input: ProjectCreateInput = {
    systemId,
    key: names.projectKey,
    name: "Dự án e2e",
    repo: {
      mode: "new",
      connectionId,
      owner,
      name: names.repo,
      visibility: "private",
      defaultBranch: "main",
      description: "Repo tạo bởi scripts/e2e-smoke.ts",
    },
    // GitHub gói Free không bảo vệ nhánh được cho repo private, và không gọi được webhook về 127.0.0.1: tắt cả hai khi
    // dùng GitHub thật. Provider local chạy được mọi bước nên bật đủ.
    protection: { protectDefault: !GITHUB, requiredApprovals: 0 },
    webhook: !GITHUB,
    idempotencyKey: randomUUID(),
  };
  const plan = await api.post<ProjectCreateResult>("/api/v1/projects", { ...input, dryRun: true });
  console.log(`  dryRun: ${plan.steps.map((s) => s.kind).join(" → ")}`);
  for (const w of plan.warnings) console.log(`  cảnh báo ${w.code}: ${w.message}`);
  if (GITHUB) state.githubRepoTried = true;
  const created = await api.post<ProjectCreateResult>("/api/v1/projects", input);
  if (!created.projectId) throw new Error("projects.create không trả projectId.");
  const projectId = created.projectId;
  const seen = new Set<string>();
  const view = await waitFor(
    "dự án sang active",
    async () => {
      const v = await api.get<ProvisionView>(`/api/v1/projects/${projectId}/provision`);
      for (const s of v.steps) {
        const mark = `${s.id}:${s.state}`;
        if (s.state !== "pending" && !seen.has(mark)) {
          seen.add(mark);
          console.log(`  [provision] ${s.kind}: ${s.state}${s.error ? ` (${s.error.code}: ${s.error.message})` : ""}`);
        }
      }
      if (v.project.state === "failed") {
        const bad = v.steps.find((s) => s.state === "failed");
        throw new GiveUp(`Provision lỗi ở ${bad?.kind}: ${bad?.error?.message ?? "không rõ"}`);
      }
      return v.project.state === "active" ? v : null;
    },
    { timeoutMs: 120_000, intervalMs: 1000, alive: state.hub },
  );
  const project: Project = view.project;
  if (!project.repo.httpUrl) throw new Error("Dự án active nhưng chưa có URL repo.");
  console.log(`  Repo ${project.repo.owner}/${project.repo.name}: ${project.repo.httpUrl}`);
  if (localGit) {
    const bare = join(localGit.root, project.repo.owner, `${project.repo.name}.git`);
    const files = await runCmd("git", ["--git-dir", bare, "ls-tree", "--name-only", "main"]);
    console.log(`  Bare repo cục bộ có: ${files.split("\n").join(", ")}`);
  }
  return project;
}

// ---- 6. Worker -----------------------------------------------------------------------------------------------------

/** Thư mục dữ liệu worker theo os.UserCacheDir() của Go với biến môi trường đã cho (worker/cmd/hive-worker). */
function workerDataDir(e: NodeJS.ProcessEnv): string {
  let cache: string;
  if (isWindows) cache = e.LocalAppData ?? "";
  else if (process.platform === "darwin") cache = join(e.HOME ?? "", "Library", "Caches");
  else cache = e.XDG_CACHE_HOME || join(e.HOME ?? "", ".cache");
  return join(cache, "xdev-hive", "worker");
}

async function startWorker(api: HubClient, teamId: string, tmp: string) {
  const bin = join(tmp, "bin", isWindows ? "hive-worker.exe" : "hive-worker");
  console.log("  go build ./cmd/hive-worker");
  await runCmd("go", ["build", "-o", bin, "./cmd/hive-worker"], { cwd: join(ROOT, "worker") });

  const workerEnv: NodeJS.ProcessEnv = { ...cleanEnv(), GIT_TERMINAL_PROMPT: "0" };
  if (!REAL_CLI) {
    // HOME và thư mục cache riêng: worker không đụng cache của máy người chạy. CLI thật cần HOME thật (đăng nhập).
    Object.assign(workerEnv, {
      HOME: join(tmp, "home"),
      XDG_CACHE_HOME: join(tmp, "cache"),
      LocalAppData: join(tmp, "cache"),
      HIVE_WORKER_CLI_OVERRIDES: JSON.stringify({
        [CLI]: { path: process.execPath, args: [join(ROOT, "scripts", "e2e-fake-cli.ts"), "{{prompt}}"] },
      }),
    });
    await mkdir(join(tmp, "home"), { recursive: true });
  } else if (env.HIVE_WORKER_CLI_OVERRIDES) {
    workerEnv.HIVE_WORKER_CLI_OVERRIDES = env.HIVE_WORKER_CLI_OVERRIDES;
  }
  if (GITHUB) {
    // Hub chưa cấp token git cho run; worker push lên GitHub bằng token của script, cách actions/checkout làm.
    const basic = Buffer.from(`x-access-token:${githubSettings().token}`).toString("base64");
    Object.assign(workerEnv, {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    });
  }
  state.workerDataDir = workerDataDir(workerEnv);

  const reg = await api.post<{ token: string; command: string }>(`/api/v1/teams/${teamId}/machines/registrations`);
  const config = join(tmp, "worker.json");
  const out = await runCmd(
    bin,
    ["register", "--hub", api.base, "--token", reg.token, "--machine", names.machine, "--config", config],
    { env: workerEnv },
  );
  console.log(`  ${out.split("\n")[0]}`);
  const worker = startProc("worker", bin, ["run", "--config", config], {
    env: workerEnv,
    log: join(tmp, "worker.log"),
  });
  state.worker = worker;
  const machine = await waitFor(
    `máy ${names.machine} online`,
    async () => {
      const list = await api.get<Array<{ id: string; name: string; status: string; clis: string[] }>>(
        `/api/v1/teams/${teamId}/machines`,
      );
      return list.find((m) => m.name === names.machine && m.status === "online");
    },
    { timeoutMs: 30_000, alive: worker },
  );
  console.log(`  Máy ${machine.name} online, CLI: ${machine.clis.join(", ") || "(không có)"}`);
  if (!machine.clis.includes(CLI)) throw new Error(`Worker không có CLI ${CLI}; hub sẽ không giao run.`);
  return { bin, machineId: machine.id, worker };
}

// ---- 7. Task, run, SSE ---------------------------------------------------------------------------------------------

function describeEvent(ev: RunEventView): string {
  const d = ev.data;
  switch (ev.type) {
    case "state":
      return `trạng thái ${String(d.from)} → ${String(d.to)}${d.reasons ? ` ${JSON.stringify(d.reasons)}` : ""}`;
    case "phase":
      return `pha ${String(d.phase)}`;
    case "offer":
      return `đề nghị máy ${String(d.machine ?? d.machineId)}`;
    case "agent_report":
      return `agent báo cáo: ${String(d.note)}`;
    case "result":
      return `kết quả từ worker: exit ${String(d.exit)}, head ${String(d.headSha ?? "-")}`;
    default:
      return `${ev.type} ${JSON.stringify(d)}`;
  }
}

/** Theo dõi SSE của run tới sự kiện `end`; nối lại bằng Last-Event-ID nếu luồng đứt giữa chừng. */
async function followRun(api: HubClient, runId: string, signal: AbortSignal): Promise<string | null> {
  let lastId = "";
  for (let attempt = 0; attempt < 20 && !signal.aborted; attempt++) {
    const res = await fetch(new URL(`/api/v1/runs/${runId}/stream`, api.base), {
      headers: api.headers({ accept: "text/event-stream", ...(lastId ? { "last-event-id": lastId } : {}) }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`SSE trả HTTP ${res.status}: ${await res.text()}`);
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk as Uint8Array, { stream: true });
      let idx = buf.indexOf("\n\n");
      while (idx >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        idx = buf.indexOf("\n\n");
        let event = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
          else if (line.startsWith("id:")) lastId = line.slice(3).trim();
        }
        if (event === "run_event") {
          console.log(`  [run] ${describeEvent(JSON.parse(data) as RunEventView)}`);
        } else if (event === "log") {
          const chunkView = JSON.parse(data) as RunLogChunk;
          for (const line of Buffer.from(chunkView.bytes, "base64").toString("utf8").split("\n")) {
            if (line.trim()) console.log(`  │ ${line}`);
          }
        } else if (event === "end") {
          return (JSON.parse(data) as { state: string | null }).state;
        }
      }
    }
    await delay(500);
  }
  return null;
}

/** Mẫu log worker in ra khi nhận gói nó không xử lý; với job_offer là lỗi thật, báo ngay thay vì chờ hết giờ. */
const UNHANDLED_OFFER = /Chưa xử lý gói từ hub.*JobOffer/;

async function runTask(api: HubClient, projectId: string, worker: Proc) {
  const task = await api.post<Task>("/api/v1/tasks", {
    projectId,
    title: "Thêm ghi chú e2e vào README",
    body: `Thêm một mục ghi chú ngắn vào cuối README.md (lần chạy ${stamp}), commit thay đổi, rồi gọi tool task_update của MCP hive để báo cáo.`,
    preferredCli: CLI,
  });
  console.log(`  Task ${task.key}: ${task.status}`);
  const run = await api.post<Run>("/api/v1/runs", { taskId: task.id, cli: CLI });
  console.log(`  Run ${run.id} trên nhánh ${run.branch}`);

  const abort = new AbortController();
  try {
    const outcome = await Promise.race([
      followRun(api, run.id, abort.signal).then((s) => ({ kind: "end" as const, state: s })),
      worker.waitForLine(UNHANDLED_OFFER).then((line) => ({ kind: "unhandled" as const, line })),
      delay(RUN_TIMEOUT_MS, undefined, { signal: abort.signal }).then(() => ({ kind: "timeout" as const })),
    ]);
    if (outcome.kind === "unhandled") {
      throw new Error(`Worker không nhận job: ${outcome.line}`);
    }
    if (outcome.kind === "timeout") {
      const now = await api.get<Run>(`/api/v1/runs/${run.id}`);
      throw new Error(`Hết ${fmtMs(RUN_TIMEOUT_MS)} mà run chưa xong (đang ${now.state}).`);
    }
    console.log(`  SSE kết thúc: ${outcome.state}`);
  } finally {
    abort.abort();
  }
  return { task, run: await api.get<Run>(`/api/v1/runs/${run.id}`) };
}

// ---- 8. Kiểm kết quả -----------------------------------------------------------------------------------------------

interface LocalPullRequest {
  number: number;
  head: string;
  base: string;
  headSha: string;
  title: string;
}

async function checkPr(run: Run, project: Project, localGit: LocalGit | null) {
  if (!run.prUrl) throw new Error("Run không có prUrl.");
  if (localGit) {
    const pr = JSON.parse(await readFile(fileURLToPath(run.prUrl), "utf8")) as LocalPullRequest;
    if (pr.head !== run.branch || pr.base !== project.repo.defaultBranch) {
      throw new Error(`PR ${pr.head} → ${pr.base}, cần ${run.branch} → ${project.repo.defaultBranch}`);
    }
    const bare = join(localGit.root, project.repo.owner, `${project.repo.name}.git`);
    const sha = await runCmd("git", ["--git-dir", bare, "rev-parse", `refs/heads/${run.branch}`]);
    if (pr.headSha !== sha || sha !== run.headSha) {
      throw new Error(`Lệch commit: PR ${pr.headSha}, nhánh ${sha}, run ${run.headSha}`);
    }
    if (!REAL_CLI) {
      const readme = await runCmd("git", ["--git-dir", bare, "show", `${run.branch}:README.md`]);
      if (!readme.includes("Ghi chú của agent giả"))
        throw new Error("README trên nhánh không có thay đổi của CLI giả.");
    }
    console.log(`  PR #${pr.number} (file ${fileURLToPath(run.prUrl)}): ${pr.title}`);
    return;
  }
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(run.prUrl);
  if (!m) throw new Error(`prUrl không phải PR GitHub: ${run.prUrl}`);
  const res = await fetch(`${GITHUB_API}/repos/${m[1]}/${m[2]}/pulls/${m[3]}`, {
    headers: { authorization: `Bearer ${githubSettings().token}`, accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub trả HTTP ${res.status} khi đọc PR: ${await res.text()}`);
  const pr = (await res.json()) as { number: number; state: string; head: { ref: string; sha: string } };
  if (pr.head.ref !== run.branch || pr.head.sha !== run.headSha) {
    throw new Error(`PR GitHub trỏ ${pr.head.ref}@${pr.head.sha}, cần ${run.branch}@${run.headSha}`);
  }
  console.log(`  PR GitHub #${pr.number} (${pr.state}): ${run.prUrl}`);
}

async function checkWorktree(run: Run) {
  const data = state.workerDataDir;
  const repoUrl = state.repoUrl;
  if (!data || !repoUrl) throw new Error("Không biết thư mục dữ liệu của worker.");
  // Cùng cách đặt tên với worker/internal/runner: cache theo sha256 của URL repo, worktree theo run và lần thử.
  const cache = join(data, "repos", `${createHash("sha256").update(repoUrl).digest("hex").slice(0, 24)}.git`);
  if (!existsSync(cache)) {
    const found = existsSync(join(data, "repos")) ? (await readdir(join(data, "repos"))).join(", ") : "không có";
    throw new Error(`Không thấy repo cache của worker ở ${cache} (repos: ${found}); đường dẫn dữ liệu worker đã đổi?`);
  }
  const work = join(data, "runs", `${run.id}-${run.attempt}`);
  // Worker gỡ worktree ngay sau khi gửi run_result, nên có thể chậm hơn sự kiện kết thúc trên hub một chút.
  await waitFor(
    `worktree ${work} được gỡ`,
    async () => {
      const list = await runCmd("git", ["--git-dir", cache, "worktree", "list", "--porcelain"]);
      const worktrees = list.split("\n").filter((l) => l.startsWith("worktree ")).length;
      // Còn đúng một mục: chính repo bare.
      return !existsSync(work) && worktrees <= 1;
    },
    { timeoutMs: 15_000 },
  );
  console.log(`  ${work} đã gỡ, ${cache} không còn worktree.`);
}

// ---- 9. Dọn dẹp ----------------------------------------------------------------------------------------------------

let cleaning: Promise<void> | null = null;

function cleanup(): Promise<void> {
  cleaning ??= timed("cleanup", async () => {
    const problems: string[] = [];
    const attempt = async (what: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
        console.log(`  ${what}: xong`);
      } catch (e) {
        problems.push(`${what}: ${errText(e)}`);
        console.log(`  ${what}: lỗi ${errText(e)}`);
      }
    };
    if (state.worker) await attempt("dừng worker", () => (state.worker as Proc).stop());
    if (state.hub) await attempt("dừng hub", () => (state.hub as Proc).stop());
    if (GITHUB && state.githubRepoTried) {
      if (CLEANUP) {
        await attempt(`xoá repo GitHub ${names.repo}`, async () => {
          const { owner, token } = githubSettings();
          const res = await fetch(`${GITHUB_API}/repos/${owner}/${names.repo}`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
          });
          // 404: saga chưa kịp tạo repo.
          if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        });
      } else {
        console.log(`  Giữ repo GitHub ${names.repo} (đặt HIVE_E2E_CLEANUP=1 để xoá).`);
      }
    }
    if (REAL_CLI && state.workerDataDir && state.repoUrl) {
      // CLI thật dùng cache thật của máy: chỉ xoá repo cache của lần chạy này.
      const hash = createHash("sha256").update(state.repoUrl).digest("hex").slice(0, 24);
      await attempt("xoá repo cache của worker", () =>
        rm(join(state.workerDataDir as string, "repos", `${hash}.git`), { recursive: true, force: true }),
      );
    }
    if (state.container)
      await attempt("dừng container Postgres", () => (state.container as { stop(): Promise<unknown> }).stop());
    if (state.tmp) {
      if (KEEP) console.log(`  Giữ thư mục tạm ${state.tmp}`);
      else await attempt("xoá thư mục tạm", () => rm(state.tmp as string, { recursive: true, force: true }));
    }
    if (problems.length) throw new Error(problems.join("; "));
  }).then(() => {});
  return cleaning;
}

// ---- Luồng chính ---------------------------------------------------------------------------------------------------

async function main(): Promise<number> {
  console.log(
    `xDev Hive e2e-smoke ${stamp}: Git ${GITHUB ? "GitHub" : "local"}, CLI ${REAL_CLI ? `thật (${CLI})` : "giả"}`,
  );
  // Cấu hình sai thì báo ngay, trước khi dựng Postgres.
  const problems = [
    ...(GITHUB && (!env.HIVE_E2E_GITHUB_TOKEN || !env.HIVE_E2E_GITHUB_OWNER)
      ? ["HIVE_E2E_GITHUB=1 cần HIVE_E2E_GITHUB_TOKEN và HIVE_E2E_GITHUB_OWNER."]
      : []),
    ...(["claude", "codex", "gemini"].includes(CLI) ? [] : [`HIVE_E2E_CLI phải là claude, codex hoặc gemini: ${CLI}`]),
    ...(RUN_TIMEOUT_MS > 0 ? [] : [`HIVE_E2E_RUN_TIMEOUT_SEC không hợp lệ: ${env.HIVE_E2E_RUN_TIMEOUT_SEC}`]),
  ];
  if (problems.length) {
    for (const p of problems) console.error(p);
    return 2;
  }
  const tmp = await mkdtemp(join(tmpdir(), "xdev-hive-e2e-smoke-"));
  state.tmp = tmp;
  const localGit: LocalGit | null = GITHUB ? null : { root: join(tmp, "git"), prDir: join(tmp, "prs") };
  if (localGit) await mkdir(localGit.root, { recursive: true });

  let interrupted = false;
  let unexpected = false;
  // Dùng on, không dùng once: signal-exit (trong Testcontainers) tự kill lại tiến trình khi thấy chỉ còn nó nghe tín
  // hiệu, làm bước dọn dẹp bị cắt ngang. Nhận tín hiệu lần hai thì thoát ngay.
  const onSignal = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.log("\nDừng theo yêu cầu, đang dọn dẹp… (nhấn Ctrl-C lần nữa để thoát ngay)");
    void cleanup().finally(() => {
      printSummary();
      process.exit(130);
    });
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const db = await step("db", startPostgres);
    const api = await step("hub", () => startHub(db, tmp, localGit));
    const { team, system } = await step("tenant", () => setupTenant(api));
    const { conn, owner } = await step("scm", () => connectGit(api));
    const project = await step("project", () => createProject(api, system.id, conn.id, owner, localGit));
    state.repoUrl = project.repo.httpUrl ?? undefined;
    const { worker } = await step("worker", () => startWorker(api, team.id, tmp));
    const { task, run } = await step("run", () => runTask(api, project.id, worker));

    await check("succeeded", async () => {
      if (run.state !== "succeeded") {
        throw new Error(`Run ${run.state}: ${(run.result?.reasons ?? []).join("; ") || "không rõ lý do"}`);
      }
      console.log(`  ${run.result?.commitCount ?? "?"} commit, file: ${run.result?.changedFiles.join(", ")}`);
    });
    await check("review", async () => {
      const now = await api.get<Task>(`/api/v1/tasks/${task.id}`);
      if (now.status !== "review") throw new Error(`Task ${now.key} đang ${now.status}, cần review.`);
    });
    await check("pr", () => checkPr(run, project, localGit));
    await check("report", async () => {
      const events = await api.get<RunEventView[]>(`/api/v1/runs/${run.id}/events?after=0&limit=1000`);
      const report = events.find((e) => e.type === "agent_report" && e.attempt === run.attempt);
      if (report) {
        console.log(`  ${String(report.data.note)}`);
        return;
      }
      // CLI thật chỉ gọi MCP khi đã cấu hình; không coi là lỗi của hệ thống.
      if (REAL_CLI) throw new Pending("CLI thật không gọi task_update (kiểm .mcp.json và token MCP).");
      throw new Error("Không có sự kiện agent_report: CLI giả không gọi được task_update qua /mcp.");
    });
    await check("worktree", () => checkWorktree(run));
  } catch (e) {
    // step() đã đổi mọi lỗi của bước thành StopFlow; lỗi khác là lỗi của chính script.
    if (!(e instanceof StopFlow)) {
      unexpected = true;
      console.error(`Lỗi của script: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    }
  }
  if (interrupted) return 130;

  const reason = stopReason ?? { status: "bỏ qua" as const, note: "script dừng giữa chừng" };
  for (const k of Object.keys(STEPS) as StepKey[]) if (k !== "cleanup") skip(k, reason.status, reason.note);
  const anyFailed = unexpected || [...results.values()].some((r) => r.status === "không đạt");
  if (anyFailed) {
    // In log trước khi dọn, vì thư mục tạm chứa log sẽ bị xoá.
    for (const p of [state.hub, state.worker]) {
      if (p) console.log(`\n── ${p.name}: 60 dòng log cuối ──\n${p.tail()}`);
    }
  }
  await cleanup();
  return printSummary() > 0 || unexpected ? 1 : 0;
}

process.exitCode = await main();
