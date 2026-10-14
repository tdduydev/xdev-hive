// Terminal Leader đầu-cuối với worker Go thật (specs/010 T107): hub trong tiến trình, `hive-worker` build từ worker/,
// `claude` thay bằng /bin/sh qua HIVE_WORKER_CLI_OVERRIDES, repo là bare repo cục bộ. Cần Go nên chỉ chạy khi
// HIVE_E2E_TERMINAL=1:
//   HIVE_E2E_TERMINAL=1 pnpm --filter @xdev-hive/hub exec vitest run src/terminal-worker.e2e.db.test.ts
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { type TerminalServerFrame, terminalServerFrame } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import WebSocket from "ws";
import { type OrgFixture, seedOrg } from "../test/org-fixture.ts";
import { seedProject } from "../test/project-fixture.ts";
import { createApp } from "./app.ts";
import { attachWorkerGateway, registerTerminalHandlers } from "./modules/fleet/index.ts";
import { createRegistration } from "./modules/fleet/registration.ts";
import { createPool, parseMasterKey, withTenant } from "./modules/platform/index.ts";
import {
  attachTerminalGateway,
  createTerminalHandlers,
  type TerminalDeps,
  terminalTokenKey,
} from "./modules/terminal/index.ts";
import { closeSession, openSession, sessionTicket } from "./modules/terminal/service.ts";

const enabled = process.env.HIVE_E2E_TERMINAL === "1";
const run = promisify(execFile);
const WORKER_DIR = fileURLToPath(new URL("../../../worker", import.meta.url));
const secret = "test-secret-0123456789abcdef-0123456789";
const tag = randomUUID().slice(0, 6);
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

describe.skipIf(!enabled)("Terminal Leader với worker Go thật", () => {
  const { adminUrl, appUrl } = inject("db");
  const admin = new pg.Pool({ connectionString: adminUrl });
  const pool = createPool(appUrl);
  let org: OrgFixture & { user: (n: string) => string };
  let server: Server;
  let baseURL = "";
  let dir = "";
  let worker: ChildProcess | undefined;
  let workerLog = "";
  let projectId = "";
  let machineId = "";
  const closers: Array<() => unknown> = [];
  const deps: TerminalDeps = { enabled: true, publicUrl: "", tokenKey: terminalTokenKey(secret) };

  const tadmin = () => org.user("tadmin");
  const asAdmin = <T>(fn: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<T>) =>
    withTenant(pool, { userId: tadmin(), orgId: org.orgId }, fn);

  async function until(check: () => Promise<boolean>, ms = 30_000) {
    const end = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > end) throw new Error(`Hết thời gian chờ. Log worker:\n${workerLog.slice(-4000)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "hive-term-e2e-"));
    const home = join(dir, "home");
    await mkdir(home, { recursive: true });
    // Bare repo làm origin của dự án: worker clone bằng file://, không ra mạng.
    const origin = join(dir, "origin.git");
    const seed = join(dir, "seed");
    await run("git", ["init", "--bare", "-b", "main", origin]);
    await run("git", ["init", "-b", "main", seed]);
    await writeFile(join(seed, "README.md"), "# demo\n");
    const git = (...args: string[]) =>
      run("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@test", ...args], { cwd: seed });
    await git("add", ".");
    await git("commit", "-m", "init");
    await git("push", origin, "main");
    await run("go", ["build", "-o", join(dir, "hive-worker"), "./cmd/hive-worker"], { cwd: WORKER_DIR });

    org = await seedOrg(admin, `term-e2e-${tag}`);
    ({ projectId } = await seedProject(admin, pool, {
      orgId: org.orgId,
      teamId: org.teamId,
      systemId: org.systemId,
      adminUserId: org.user("admin"),
      masterKey: parseMasterKey(randomBytes(32).toString("base64")),
      key: `TE${tag}`,
    }));
    await admin.query("update hive.projects set repo_http_url = $1 where id = $2", [`file://${origin}`, projectId]);

    server = serve({ fetch: (req) => appFetch(req), port: 0, hostname: "127.0.0.1" }) as Server;
    await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    deps.publicUrl = baseURL;
    const app = createApp({
      config: { port: 0, version: "t", publicUrl: baseURL, authSecret: secret, remoteTerminal: true },
      pool,
    });
    appFetch = (req) => app.fetch(req);
    const gateway = attachWorkerGateway(server, { pool, heartbeatSec: 5, logger: quiet });
    closers.push(registerTerminalHandlers(createTerminalHandlers(pool)));
    const terminal = attachTerminalGateway(server, { pool, publicUrl: baseURL, logger: quiet });
    closers.push(
      () => terminal.close(),
      () => gateway.close(),
    );

    const { token } = await asAdmin((tx) => createRegistration(tx, tadmin(), org.teamId, "worker", { shared: true }));
    const config = join(dir, "worker.json");
    const env = {
      ...process.env,
      HOME: home,
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_CONFIG_HOME: join(home, ".config"),
      HIVE_WORKER_CLI_OVERRIDES: JSON.stringify({ claude: { path: "/bin/sh", args: [] } }),
      HIVE_RUN_TOKEN: "khong-duoc-lot-vao-phien",
    };
    await run(
      join(dir, "hive-worker"),
      ["register", "--hub", baseURL, "--token", token, "--machine", `e2e-${tag}`, "--config", config],
      { env },
    );
    worker = spawn(join(dir, "hive-worker"), ["run", "--config", config, "--capacity", "1"], { env });
    worker.stdout?.on("data", (d) => (workerLog += d));
    worker.stderr?.on("data", (d) => (workerLog += d));
    await until(async () => {
      const r = await admin.query("select id, status, capabilities from hive.machines where org_id = $1", [org.orgId]);
      machineId = r.rows[0]?.id ?? "";
      return r.rows[0]?.status === "online" && ((r.rows[0]?.capabilities ?? []) as string[]).includes("terminal");
    });
  }, 180_000);

  let appFetch: (req: Request) => Response | Promise<Response> = () => new Response(null, { status: 503 });

  afterAll(async () => {
    worker?.kill("SIGTERM");
    for (const close of closers.reverse()) await close();
    if (server) await new Promise((resolve) => server.close(resolve));
    await Promise.all([admin.end(), pool.end()]);
    if (dir && process.env.HIVE_E2E_KEEP !== "1") await rm(dir, { recursive: true, force: true });
  });

  it("mở phiên, gõ vào PTY thật trong worktree tạm, nhận output, đóng thì dọn worktree", async () => {
    const opened = await asAdmin((tx) =>
      openSession(
        tx,
        { id: tadmin(), name: "tadmin" },
        org.orgId,
        { projectId, machineId, mode: "propose", model: "sonnet", cols: 100, rows: 30 },
        deps,
      ),
    );
    opened.afterCommit();
    const id = opened.session.id;
    await until(async () => {
      const r = await admin.query("select state from hive.terminal_sessions where id = $1", [id]);
      return r.rows[0]?.state === "running";
    });
    const { ticket, canInput } = await asAdmin((tx) => sessionTicket(tx, tadmin(), org.orgId, id));
    expect(canInput).toBe(true);
    const ws = new WebSocket(`${baseURL.replace("http", "ws")}/ws/terminal?ticket=${ticket}`, {
      headers: { origin: baseURL },
    });
    let screen = "";
    const frames: TerminalServerFrame[] = [];
    ws.on("message", (data) => {
      const f = terminalServerFrame.parse(JSON.parse(data.toString()));
      frames.push(f);
      if (f.t === "out") screen += Buffer.from(f.data, "base64").toString();
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    closers.push(() => ws.close());
    const type = (s: string) => ws.send(JSON.stringify({ t: "in", data: Buffer.from(s).toString("base64") }));
    // biome-ignore lint/suspicious/noTemplateCurlyInString: lệnh của sh, `${…}` là biến shell.
    type("echo xin-chao-$((40+2)); pwd; echo token=${HIVE_RUN_TOKEN:-khong-co}\r");
    await until(async () => screen.includes("xin-chao-42") && screen.includes("token="), 15_000).catch(async (e) => {
      const chunks = await admin.query(
        "select seq, length(data) as n from hive.terminal_chunks where session_id = $1",
        [id],
      );
      throw new Error(
        `${e}\nlog=${workerLog.slice(-3000)}\nscreen=${JSON.stringify(screen)}\nframes=${JSON.stringify(frames.map((f) => f.t))}\nchunks=${JSON.stringify(chunks.rows)}`,
      );
    });
    expect(screen).toContain("token=khong-co");
    expect(screen).toMatch(/terminals[/\\]/);
    const closed = await asAdmin((tx) => closeSession(tx, tadmin(), id));
    closed.afterCommit();
    // sh chết vì SIGHUP nên không có mã thoát; phiên đã "closed" từ lúc hub đóng.
    const row = await admin.query("select state from hive.terminal_sessions where id = $1", [id]);
    expect(row.rows[0]?.state).toBe("closed");
    // Worktree tạm của phiên đã bị xoá trên máy.
    await until(async () => {
      const roots = [join(dir, "home", "Library", "Caches"), join(dir, "home", ".cache")];
      for (const root of roots) {
        const terminals = join(root, "xdev-hive", "worker", "terminals");
        if (existsSync(terminals) && (await readdir(terminals)).length > 0) return false;
      }
      return true;
    }, 15_000);
    const stored = await admin.query("select count(*)::int as n from hive.terminal_chunks where session_id = $1", [id]);
    expect(stored.rows[0].n).toBeGreaterThan(0);
  }, 120_000);
});
