/// <reference lib="dom" />
// Điều khiển từ xa đầu-cuối (specs/010 T090): Postgres → hub thật (phục vụ bản build của web) → hive-worker và hive build
// từ worker/ → CLI giả trong PTY → Chromium có authenticator ảo, đóng vai điện thoại. Mọi kết nối tới hub đi qua một proxy
// TCP trễ HIVE_E2E_REMOTE_DELAY_MS mỗi chiều; điện thoại và máy mỗi bên một kết nối riêng nên mỗi chặng (điện thoại↔hub,
// hub↔máy) thêm RTT gấp đôi số đó. Đo SC-002 → SC-005, in bảng và ghi .e2e/remote/report.json.
//
// Chạy trên macOS/Linux (`hive chat` cần PTY của worker): `node scripts/e2e-remote.ts`. Cần Go, Docker (hoặc
// HIVE_E2E_DATABASE_ADMIN_URL như e2e-smoke) và Chromium của Playwright
// (`pnpm --filter @xdev-hive/web exec playwright install chromium`). Biến môi trường:
//   HIVE_E2E_REMOTE_DELAY_MS    trễ mỗi chiều của mỗi chặng (mặc định 50).
//   HIVE_E2E_REMOTE_OUTAGE_SEC  điện thoại mất mạng bao lâu ở SC-004 (mặc định 30; spec cho tới 120).
//   HIVE_E2E_REMOTE_HEADED=1    mở cửa sổ Chromium để xem.
//   HIVE_E2E_KEEP=1             giữ thư mục tạm (dùng chung với e2e-smoke).
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer, type Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { cleanEnv, cleanup, type Proc, ROOT, runCmd, startPostgres, startProc, state } from "./e2e-smoke.ts";

// Playwright chỉ là dependency của apps/web: bản chạy nạp qua require của apps/web, còn kiểu khai phần đang dùng ở đây vì
// tsc -p scripts không lần được 'playwright/test' qua symlink của pnpm.
interface Locator {
  waitFor(opts?: { timeout?: number }): Promise<void>;
  fill(value: string): Promise<void>;
  click(): Promise<void>;
  filter(opts: { hasText: string }): Locator;
  getByText(text: string): Locator;
}
interface WebSocketLike {
  url(): string;
  on(event: "framereceived", fn: (f: { payload: string | Buffer }) => void): void;
  on(event: "close", fn: () => void): void;
}
interface Page {
  goto(url: string): Promise<unknown>;
  close(): Promise<void>;
  context(): BrowserContext;
  locator(selector: string): Locator;
  getByLabel(text: string): Locator;
  getByText(text: string): Locator;
  getByRole(role: string, opts?: { name?: string; exact?: boolean }): Locator;
  evaluate<R>(fn: () => R): Promise<Awaited<R>>;
  keyboard: { type(text: string): Promise<void>; press(key: string): Promise<void> };
  on(event: "websocket", fn: (ws: WebSocketLike) => void): void;
}
interface CDPSession {
  // biome-ignore lint/suspicious/noExplicitAny: giao thức CDP rộng, chỉ gọi vài lệnh WebAuthn.
  send(method: string, params?: object): Promise<any>;
}
interface APIResponse {
  ok(): boolean;
  status(): number;
  text(): Promise<string>;
}
interface APIRequestContext {
  fetch(url: string, opts: { method: string; headers: Record<string, string>; data?: unknown }): Promise<APIResponse>;
}
interface BrowserContext {
  request: APIRequestContext;
  newPage(): Promise<Page>;
  newCDPSession(page: Page): Promise<CDPSession>;
  addInitScript<A>(fn: (arg: A) => void, arg: A): Promise<void>;
}
interface Browser {
  newContext(opts: {
    baseURL: string;
    locale: string;
    viewport: { width: number; height: number };
  }): Promise<BrowserContext>;
  close(): Promise<void>;
}

const env = process.env;
const DELAY_MS = Number(env.HIVE_E2E_REMOTE_DELAY_MS ?? 50);
const OUTAGE_MS = Number(env.HIVE_E2E_REMOTE_OUTAGE_SEC ?? 30) * 1000;
const isWindows = process.platform === "win32";
const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const email = `e2e-remote-${stamp}@example.com`;
const password = `${randomBytes(12).toString("base64url")}-Aa1`;
const machineName = `e2e-remote-${stamp}`;
const outputDir = join(ROOT, ".e2e", "remote");

// ---- Kết quả ---------------------------------------------------------------------------------------------------------

interface Check {
  sc: string;
  name: string;
  ok: boolean;
  measured: string;
  limit: string;
  evidence?: unknown;
}
const checks: Check[] = [];

function record(c: Check) {
  checks.push(c);
  console.log(`  ${c.ok ? "đạt" : "KHÔNG ĐẠT"}  ${c.sc} ${c.name}: ${c.measured} (giới hạn ${c.limit})`);
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? Number.NaN;
}

async function until<T>(what: string, probe: () => Promise<T | undefined | null | false>, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe().catch(() => undefined);
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`Hết giờ chờ ${what}.`);
    await delay(100);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolvePort(port));
    });
  });
}

// ---- Proxy trễ ---------------------------------------------------------------------------------------------------------

/**
 * Proxy TCP giữa mọi client và hub, trễ mỗi lát dữ liệu `delayMs` theo từng chiều (setTimeout cùng độ trễ giữ đúng thứ tự).
 * Kết nối của trình duyệt nhận ra bằng User-Agent ở yêu cầu đầu; `outage` chỉ cắt các kết nối đó, worker vẫn nối hub.
 */
function delayProxy(listenPort: number, hubPort: number, delayMs: number) {
  const browserSockets = new Set<Socket>();
  let downUntil = 0;
  const server: Server = createServer((client) => {
    const upstream = new Socket().connect(hubPort, "127.0.0.1");
    let first = true;
    const forward = (from: Socket, to: Socket) =>
      from.on("data", (chunk) => {
        setTimeout(() => {
          if (!to.destroyed) to.write(chunk);
        }, delayMs);
      });
    client.on("data", (chunk) => {
      if (!first) return;
      first = false;
      if (/user-agent:[^\r\n]*(Mozilla|Chrome)/i.test(chunk.toString("latin1"))) {
        browserSockets.add(client);
        client.once("close", () => browserSockets.delete(client));
        if (Date.now() < downUntil) client.destroy();
      }
    });
    forward(client, upstream);
    forward(upstream, client);
    const end = () => {
      setTimeout(() => {
        client.destroy();
        upstream.destroy();
      }, delayMs);
    };
    client.on("close", end).on("error", end);
    upstream.on("close", end).on("error", end);
  });
  server.listen(listenPort, "127.0.0.1");
  return {
    /** Điện thoại mất mạng `ms`: đóng kết nối đang có và từ chối kết nối mới của trình duyệt tới khi hết giờ. */
    outage(ms: number) {
      downUntil = Date.now() + ms;
      for (const s of browserSockets) s.destroy();
    },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

// ---- CLI giả ------------------------------------------------------------------------------------------------------------

/** Agent giả trong PTY: "dump" in 512 KiB rồi DUMP-END; "ticks N" in N dòng, 100 ms một dòng; còn lại in lại dòng. */
const FAKE_AGENT = `
import { createInterface } from "node:readline";
process.stdout.write("READY\\n");
let tick = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  if (line === "dump") {
    const row = "x".repeat(1023) + "\\n";
    for (let i = 0; i < 512; i++) process.stdout.write(row);
    process.stdout.write("DUMP-END\\n");
  } else if (line.startsWith("ticks ")) {
    const stop = tick + Number(line.slice(6));
    const t = setInterval(() => {
      process.stdout.write("tick " + ++tick + "\\n");
      if (tick >= stop) { clearInterval(t); process.stdout.write("TICKS-END\\n"); }
    }, 100);
  } else {
    process.stdout.write("got:" + line + "\\n");
  }
});
`;

// ---- Hub, tổ chức, máy ---------------------------------------------------------------------------------------------------

async function startHub(tmp: string, publicUrl: string, hubPort: number) {
  const db = await startPostgres();
  const webDist = join(ROOT, "apps", "web", "dist");
  if (!existsSync(join(webDist, "index.html"))) {
    console.log("  pnpm --filter @xdev-hive/web build");
    await runCmd("pnpm", ["--filter", "@xdev-hive/web", "build"], { cwd: ROOT });
  }
  const hub = startProc("hub", process.execPath, ["apps/hub/src/main.ts"], {
    env: {
      ...cleanEnv(),
      HIVE_PORT: String(hubPort),
      // Origin trình duyệt thấy, cũng là URL worker dùng để kiểm origin/rpId của passkey: phải là localhost (WebAuthn không
      // nhận địa chỉ IP) và đi qua proxy trễ.
      HIVE_PUBLIC_URL: publicUrl,
      HIVE_DATABASE_URL: db.appUrl,
      HIVE_DATABASE_AUTH_URL: db.authUrl,
      HIVE_DATABASE_JOBS_URL: db.jobsUrl,
      HIVE_MASTER_KEY: randomBytes(32).toString("base64"),
      HIVE_AUTH_SECRET: randomBytes(32).toString("base64url"),
      HIVE_ALLOW_EMAIL_SIGNUP: "1",
      HIVE_ORG_CREATORS: email,
      HIVE_REMOTE_TERMINAL: "1",
      HIVE_WEB_DIST: webDist,
      HIVE_WORKER_RELEASES: "off",
      HIVE_DESKTOP_RELEASES: "off",
    },
    log: join(tmp, "hub.log"),
  });
  state.hub = hub;
  await until("hub trả /api/v1/health", async () => (await fetch(`${publicUrl}/api/v1/health`)).ok, 60_000);
}

/** Gọi API của hub bằng cookie của chính trình duyệt, để trang web dùng chung phiên đăng nhập. */
function hubApi(request: APIRequestContext, publicUrl: string) {
  let orgId = "";
  const call = async <T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> => {
    const res = await request.fetch(`${publicUrl}${path}`, {
      method,
      headers: { origin: publicUrl, ...(orgId ? { "x-hive-org": orgId } : {}) },
      ...(body === undefined ? {} : { data: body }),
    });
    const text = await res.text();
    if (!res.ok()) throw new Error(`${method} ${path} → HTTP ${res.status()}: ${text.slice(0, 400)}`);
    return (text ? JSON.parse(text) : null) as T;
  };
  return {
    get: <T>(path: string) => call<T>("GET", path),
    post: <T>(path: string, body: unknown = {}) => call<T>("POST", path, body),
    setOrg: (id: string) => {
      orgId = id;
    },
  };
}
type HubApi = ReturnType<typeof hubApi>;

async function setupTenant(api: HubApi) {
  await api.post("/api/auth/sign-up/email", { name: "Người thử remote", email, password });
  const me = await api.get<{ id: string }>("/api/v1/me");
  const org = await api.post<{ id: string }>("/api/v1/orgs", { name: `Remote ${stamp}`, slug: `e2e-remote-${stamp}` });
  api.setOrg(org.id);
  const team = await api.post<{ id: string }>("/api/v1/teams", {
    name: "Đội remote",
    slug: "doi-remote",
    adminUserId: me.id,
  });
  return { orgId: org.id, teamId: team.id };
}

async function startMachine(api: HubApi, teamId: string, tmp: string, publicUrl: string) {
  const bin = join(tmp, "bin");
  for (const cmd of ["hive-worker", "hive"]) {
    console.log(`  go build ./cmd/${cmd}`);
    await runCmd("go", ["build", "-o", join(bin, cmd), `./cmd/${cmd}`], { cwd: join(ROOT, "worker") });
  }
  const agent = join(tmp, "fake-agent.mjs");
  await writeFile(agent, FAKE_AGENT);
  const work = join(tmp, "work");
  await mkdir(join(tmp, "home"), { recursive: true });
  await mkdir(work, { recursive: true });
  const machineEnv: NodeJS.ProcessEnv = {
    ...cleanEnv(),
    HOME: join(tmp, "home"),
    XDG_CACHE_HOME: join(tmp, "cache"),
    // Socket nội bộ riêng: hive và hive-worker của lần chạy này không đụng worker thật trên máy.
    HIVE_SOCKET: join(tmp, "hive.sock"),
    HIVE_WORKER_CLI_OVERRIDES: JSON.stringify({ claude: { path: process.execPath, args: [agent] } }),
  };
  const reg = await api.post<{ token: string }>(`/api/v1/teams/${teamId}/machines/registrations`, {});
  const config = join(tmp, "worker.json");
  await runCmd(
    join(bin, "hive-worker"),
    ["register", "--hub", publicUrl, "--token", reg.token, "--machine", machineName, "--config", config],
    { env: machineEnv },
  );
  state.worker = startProc("worker", join(bin, "hive-worker"), ["run", "--capacity", "1", "--config", config], {
    env: machineEnv,
    log: join(tmp, "worker.log"),
  });
  const machine = await until("máy online", async () => {
    const list = await api.get<Array<{ id: string; name: string; status: string }>>(`/api/v1/teams/${teamId}/machines`);
    return list.find((m) => m.name === machineName && m.status === "online");
  });
  const hive = (args: string[], opts: { cwd?: string } = {}) =>
    runCmd(join(bin, "hive"), args, { env: machineEnv, cwd: opts.cwd ?? work });
  const spawnHive = (args: string[]) =>
    spawn(join(bin, "hive"), args, { env: machineEnv, cwd: work, stdio: ["pipe", "pipe", "pipe"] });
  return { machineId: machine.id, work, hive, spawnHive };
}
type Machine = Awaited<ReturnType<typeof startMachine>>;

/** Gom stdout/stderr của tiến trình con để chờ một dòng. */
function watchOutput(child: ChildProcess) {
  let text = "";
  child.stdout?.on("data", (b: Buffer) => {
    text += b.toString();
  });
  child.stderr?.on("data", (b: Buffer) => {
    text += b.toString();
  });
  return {
    text: () => text,
    wait: (re: RegExp, ms = 30_000) => until(`"${re.source}" từ hive`, async () => text.match(re), ms),
  };
}

// ---- Trình duyệt -----------------------------------------------------------------------------------------------------------

async function virtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

/** Số chữ ký passkey đã làm: tăng tức là trình duyệt đã hỏi passkey thêm một lần. */
async function signCount(cdp: CDPSession, authenticatorId: string) {
  const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  return credentials[0]?.signCount ?? 0;
}

/** Ghép điện thoại như người dùng: `hive remote pair` in link, trang ghép tạo passkey, chủ máy trả lời "y" tại máy. */
async function pair(page: Page, machine: Machine, publicUrl: string) {
  const proc = machine.spawnHive(["remote", "pair"]);
  const out = watchOutput(proc);
  const [, link] = await out.wait(/mở link này trên điện thoại: (\S+)/);
  if (!link?.startsWith(publicUrl)) throw new Error(`Link ghép ${link} không trỏ tới ${publicUrl}.`);
  await page.goto(link);
  await page.getByLabel("Tên thiết bị").fill("Điện thoại e2e");
  await page.getByRole("button", { name: "Tạo passkey và ghép" }).click();
  await out.wait(/Cho phép\? \[y\/N\]/);
  proc.stdin?.write("y\n");
  await page.getByRole("status").filter({ hasText: "Đã ghép" }).waitFor({ timeout: 30_000 });
  await until("hive remote pair kết thúc", async () => proc.exitCode !== null);
  if (proc.exitCode !== 0) throw new Error(`hive remote pair thoát mã ${proc.exitCode}: ${out.text()}`);
}

interface Frames {
  out: Map<number, string>;
  events: Array<{ at: number; t: string; reason?: string }>;
  closedAt: number[];
}

/** Ghi mọi khung `/ws/terminal` trang nhận được: `out` theo seq (gồm cả các lần nối lại), các khung khác kèm thời điểm. */
function captureFrames(page: Page): Frames {
  const frames: Frames = { out: new Map(), events: [], closedAt: [] };
  page.on("websocket", (ws) => {
    if (!ws.url().includes("/ws/terminal")) return;
    ws.on("framereceived", ({ payload }) => {
      const f = JSON.parse(payload.toString()) as { t: string; seq?: number; data?: string; reason?: string };
      if (f.t === "out" && f.seq !== undefined && f.data !== undefined) frames.out.set(f.seq, f.data);
      else frames.events.push({ at: Date.now(), t: f.t, ...(f.reason ? { reason: f.reason } : {}) });
    });
    ws.on("close", () => frames.closedAt.push(Date.now()));
  });
  return frames;
}

async function takeControl(page: Page) {
  await page.getByText("Đang xem trực tiếp.").waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Điều khiển", exact: true }).click();
  await page.getByText("Bạn đang điều khiển phiên này.").waitFor({ timeout: 30_000 });
}

async function allChunks(api: HubApi, sessionId: string) {
  const chunks = new Map<number, string>();
  let after = -1;
  for (;;) {
    const page = await api.get<{ chunks: Array<{ seq: number; data: string }>; more: boolean }>(
      `/api/v1/remote/sessions/${sessionId}/chunks?after=${after}&limit=500`,
    );
    for (const c of page.chunks) chunks.set(c.seq, c.data);
    after = page.chunks.at(-1)?.seq ?? after;
    if (!page.more) return chunks;
  }
}

// ---- Các phép đo ---------------------------------------------------------------------------------------------------------

/** SC-003: mở phiên đang chạy (đuôi 512 KiB) tới khi thấy màn hình hiện tại, mỗi lần một trang mới. */
async function measureOpen(
  context: BrowserContext,
  sessionId: string,
  chat: ReturnType<typeof watchOutput>,
  stdin: NodeJS.WritableStream,
) {
  stdin.write("dump\n");
  await chat.wait(/DUMP-END/, 60_000);
  await delay(1000);
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const page = await context.newPage();
    const started = Date.now();
    await page.goto(`/remote/${sessionId}`);
    await page.locator(".xterm-rows").getByText("DUMP-END").waitFor({ timeout: 30_000 });
    times.push(Date.now() - started);
    await page.close();
  }
  const p95 = percentile(times, 0.95);
  record({
    sc: "SC-003",
    name: "mở phiên đang chạy, đuôi 512 KiB",
    ok: p95 <= 2000,
    measured: `p95 ${p95} ms`,
    limit: "2000 ms",
    evidence: times,
  });
}

/**
 * SC-002: phím gõ trên điện thoại → chữ PTY in lại hiện trên điện thoại. Đo trong trang (keydown → DOM của xterm đổi), nên
 * không tính độ trễ của Playwright; xterm vẽ theo khung hình nên số đo gồm cả tối đa một khung (~16 ms).
 */
async function measureKeys(page: Page) {
  await page.evaluate(() => {
    const rows = document.querySelector(".xterm-rows") as HTMLElement;
    const w = window as unknown as {
      __keys: { pending?: { ch: string; t: number; n: number } | undefined; samples: number[] };
    };
    w.__keys = { samples: [] };
    const count = (ch: string) => (rows.textContent ?? "").split(ch).length - 1;
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key.length === 1) w.__keys.pending = { ch: e.key, t: performance.now(), n: count(e.key) };
      },
      true,
    );
    new MutationObserver(() => {
      const p = w.__keys.pending;
      if (p && count(p.ch) > p.n) {
        w.__keys.samples.push(performance.now() - p.t);
        w.__keys.pending = undefined;
      }
    }).observe(rows, { subtree: true, childList: true, characterData: true });
  });
  await page.locator(".xterm").click();
  for (const ch of "qwzjkvbnmp".repeat(2)) {
    await page.keyboard.type(ch);
    await delay(300);
  }
  await page.keyboard.press("Enter");
  const samples = await page.evaluate(() => (window as unknown as { __keys: { samples: number[] } }).__keys.samples);
  const p95 = percentile(samples, 0.95);
  const limit = 4 * DELAY_MS + 60;
  record({
    sc: "SC-002",
    name: `phím → chữ trên điện thoại (trễ ${DELAY_MS} ms mỗi chiều mỗi chặng)`,
    ok: samples.length === 20 && p95 <= limit,
    measured: `p95 ${Math.round(p95)} ms, ${samples.length}/20 mẫu`,
    limit: `${limit} ms`,
    evidence: samples.map(Math.round),
  });
}

/** SC-004: điện thoại mất mạng trong lúc máy vẫn in; nối lại thì đủ mọi seq như bản ghi và không hỏi passkey. */
async function measureOutage(
  page: Page,
  api: HubApi,
  sessionId: string,
  frames: Frames,
  proxy: ReturnType<typeof delayProxy>,
  stdin: NodeJS.WritableStream,
  passkeys: () => Promise<number>,
) {
  const signsBefore = await passkeys();
  const firstSeq = Math.max(...frames.out.keys()) + 1;
  stdin.write(`ticks ${Math.ceil((OUTAGE_MS + 10_000) / 100)}\n`);
  await delay(2000);
  proxy.outage(OUTAGE_MS);
  await page.getByRole("status").filter({ hasText: "Mất kết nối, đang nối lại…" }).waitFor({ timeout: 10_000 });
  await delay(OUTAGE_MS);
  await page.getByText("Bạn đang điều khiển phiên này.").waitFor({ timeout: 60_000 });
  await page.locator(".xterm-rows").getByText("TICKS-END").waitFor({ timeout: 60_000 });
  await delay(1000);
  const recorded = await allChunks(api, sessionId);
  const lastSeq = Math.max(...recorded.keys());
  const missing: number[] = [];
  const differs: number[] = [];
  for (let seq = firstSeq; seq <= lastSeq; seq++) {
    const got = frames.out.get(seq);
    if (got === undefined) missing.push(seq);
    else if (got !== recorded.get(seq)) differs.push(seq);
  }
  const extraSigns = (await passkeys()) - signsBefore;
  record({
    sc: "SC-004",
    name: `mất mạng ${OUTAGE_MS / 1000} s rồi nối lại`,
    ok: missing.length === 0 && differs.length === 0 && extraSigns === 0,
    measured: `thiếu ${missing.length} seq, khác ${differs.length} seq (seq ${firstSeq}..${lastSeq}), hỏi passkey thêm ${extraSigns} lần`,
    limit: "0 seq thiếu, 0 lần hỏi passkey",
    evidence: { missing: missing.slice(0, 20), differs: differs.slice(0, 20) },
  });
}

/** SC-005: tắt từ xa → điện thoại nhận `revoked` (mất quyền) và WS bị đóng (mất kết nối), mỗi việc ≤ 2 giây. */
async function measureOff(page: Page, frames: Frames, how: string, off: () => Promise<unknown>) {
  const eventsBefore = frames.events.length;
  const closesBefore = frames.closedAt.length;
  const started = Date.now();
  await off();
  const revoked = await until(
    "khung revoked",
    async () => frames.events.slice(eventsBefore).find((e) => e.t === "revoked"),
    10_000,
  ).catch(() => undefined);
  const closed = await until("WS đóng", async () => frames.closedAt[closesBefore], 10_000).catch(() => undefined);
  await page
    .getByText("Chủ máy đã tắt điều khiển từ xa.")
    .waitFor({ timeout: 10_000 })
    .catch(() => undefined);
  const revokedMs = revoked ? revoked.at - started : Number.POSITIVE_INFINITY;
  const closedMs = closed ? closed - started : Number.POSITIVE_INFINITY;
  record({
    sc: "SC-005",
    name: `tắt từ xa (${how})`,
    ok: revoked?.reason === "disabled" && revokedMs <= 2000 && closedMs <= 2000,
    measured: `mất quyền sau ${revokedMs} ms (${revoked?.reason ?? "không có revoked"}), mất kết nối sau ${closedMs} ms`,
    limit: "2000 ms",
  });
}

// ---- Luồng chính ---------------------------------------------------------------------------------------------------------

async function main(): Promise<number> {
  if (isWindows) {
    console.log("e2e-remote cần PTY của worker trên macOS/Linux; bỏ qua trên Windows.");
    return 0;
  }
  const require = createRequire(join(ROOT, "apps", "web", "package.json"));
  const { chromium } = (await import(pathToFileURL(require.resolve("@playwright/test")).href)) as {
    chromium: { launch(opts: { headless: boolean }): Promise<Browser> };
  };

  const tmp = await mkdtemp(join(tmpdir(), "hive-remote-"));
  state.tmp = tmp;
  const [hubPort, publicPort] = [await freePort(), await freePort()];
  const publicUrl = `http://localhost:${publicPort}`;
  const proxy = delayProxy(publicPort, hubPort, DELAY_MS);
  const browser = await chromium.launch({ headless: env.HIVE_E2E_REMOTE_HEADED !== "1" });
  let chat: ChildProcess | undefined;
  let failed = false;
  try {
    console.log(`xDev Hive e2e-remote ${stamp}: trễ ${DELAY_MS} ms mỗi chiều mỗi chặng, hub ${publicUrl}`);
    await startHub(tmp, publicUrl, hubPort);
    const context = await browser.newContext({
      baseURL: publicUrl,
      locale: "vi-VN",
      viewport: { width: 360, height: 740 },
    });
    const api = hubApi(context.request, publicUrl);
    const { orgId, teamId } = await setupTenant(api);
    await context.addInitScript((org) => localStorage.setItem("hive.org", org), orgId);
    const machine = await startMachine(api, teamId, tmp, publicUrl);
    await machine.hive(["remote", "on", "--yes"]);
    await machine.hive(["remote", "roots", "add", machine.work, "--label", "e2e"]);

    const phone = await context.newPage();
    const { cdp, authenticatorId } = await virtualAuthenticator(phone);
    await pair(phone, machine, publicUrl);
    console.log("  Đã ghép điện thoại.");

    chat = machine.spawnHive(["chat", "--cli", "claude"]);
    const chatOut = watchOutput(chat);
    await chatOut.wait(/READY/);
    const sessionId = await until("phiên trên hub", async () => {
      const list = JSON.parse(await machine.hive(["ls", "--json"])) as Array<{ hubId: string }>;
      return list[0]?.hubId;
    });
    if (!chat.stdin) throw new Error("Không có stdin của hive chat.");
    console.log(`  Phiên ${sessionId}.`);

    await measureOpen(context, sessionId, chatOut, chat.stdin);

    const frames = captureFrames(phone);
    await phone.goto(`/remote/${sessionId}`);
    await takeControl(phone);
    await measureKeys(phone);
    await measureOutage(phone, api, sessionId, frames, proxy, chat.stdin, () => signCount(cdp, authenticatorId));

    await measureOff(phone, frames, "từ hub, như nút trên điện thoại", () =>
      api.post(`/api/v1/remote/machines/${machine.machineId}/disable`),
    );
    await machine.hive(["remote", "on", "--yes"]);
    await phone.goto(`/remote/${sessionId}`);
    await takeControl(phone);
    await measureOff(phone, frames, "tại máy, hive remote off", () => machine.hive(["remote", "off"]));
  } catch (e) {
    failed = true;
    console.error(`\nLỗi: ${e instanceof Error ? e.stack : String(e)}`);
    for (const p of [state.hub, state.worker] as Array<Proc | undefined>) {
      if (p) console.log(`\n── ${p.name}: 60 dòng log cuối ──\n${p.tail()}`);
    }
  } finally {
    chat?.kill();
    await browser.close();
    await proxy.close();
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      join(outputDir, "report.json"),
      `${JSON.stringify({ stamp, delayMs: DELAY_MS, outageMs: OUTAGE_MS, failed, checks }, null, 2)}\n`,
    );
    await cleanup().catch((e) => console.error(`Dọn dẹp lỗi: ${e}`));
  }
  const bad = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - bad}/${checks.length} phép đo đạt. Báo cáo: ${join(outputDir, "report.json")}`);
  return failed || bad > 0 || checks.length < 5 ? 1 : 0;
}

process.exitCode = await main();
