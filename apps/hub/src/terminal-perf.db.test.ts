// Hiệu năng xem phiên máy cá nhân (specs/010 SC-008): 50 phiên trực tiếp, mỗi phiên 3 người xem, mỗi phiên 20 KiB/s
// output. Người xem nhanh không được mất khung nào (không `sync`, không hổng seq) và bản ghi phải đủ mọi lát.
// Máy giả và trình duyệt giả chạy trong worker thread, nên mức bận event loop của luồng chính chỉ là phần của hub:
// đó là số đo CPU của tiến trình `api`. Máy CI chạy nhanh chậm thất thường nên chỉ kiểm trần rộng; số đo thật in ra
// log, HIVE_TERMINAL_PERF_REPORT=<file> ghi thêm ra file JSON.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { Session } from "node:inspector";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { PROTOCOL_VERSION } from "@xdev-hive/contracts/worker-protocol";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type OrgFixture, seedOrg } from "../test/org-fixture.ts";
import {
  attachWorkerGateway,
  createRegistration,
  registerMachine,
  registerTerminalHandlers,
} from "./modules/fleet/index.ts";
import { createPool, withTenant } from "./modules/platform/index.ts";
import { attachTerminalGateway, createTerminalHandlers, withRemoteLive } from "./modules/terminal/index.ts";
import { remoteTicket } from "./modules/terminal/ws.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const tag = randomUUID().slice(0, 6);

/** 10 máy × 5 phiên: dưới `recordedSessionsPerMachine` và hạn mức băng thông chung của một máy. */
const MACHINES = 10;
const SESSIONS_PER_MACHINE = 5;
const VIEWERS = 3;
const CHUNK_BYTES = 4096;
const INTERVAL_MS = 200;
const CHUNKS = 50;
/**
 * Mục tiêu SC-008 là tăng ≤ 15% (một nhân). Phần lớn CPU là ghi socket cho 750 khung người xem mỗi giây và một
 * transaction cho mỗi lát output; số đo thật ghi ở tasks.md T090. Trần ở đây chỉ bắt hồi quy rõ rệt.
 */
const CPU_CEILING_PCT = 80;

/**
 * Máy giả và trình duyệt giả. JavaScript thuần (eval) vì worker thread không qua bộ biến đổi TypeScript của vitest.
 * Mỗi lát output mang giờ gửi ở đầu để người xem đo độ trễ máy → hub → trình duyệt.
 */
const CLIENTS = `
const { parentPort, workerData } = require("node:worker_threads");
const { randomUUID } = require("node:crypto");
const WebSocket = require(workerData.wsPath);
const { host, proto } = workerData;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const machines = [];
const viewers = [];
const send = (ws, msg) => ws.send(JSON.stringify({ v: proto, id: randomUUID(), ...msg }));

async function connect(m) {
  const ws = new WebSocket("ws://" + host + "/ws/worker", { headers: { authorization: "Bearer " + m.token } });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  const welcomed = new Promise((resolve) =>
    ws.on("message", (d) => { if (JSON.parse(d.toString()).type === "welcome") resolve(); }),
  );
  send(ws, { type: "hello", machineId: m.name, version: "0.9.0", protoRange: [proto, proto], os: "darwin",
    clis: ["claude"], capacity: 1, capabilities: ["terminal"] });
  await welcomed;
  for (const sessionId of m.sessions) {
    send(ws, { type: "term_opened", sessionId, accountLabel: "Gói cá nhân", permissions: "workspace", origin: "local",
      cli: "claude", cwdLabel: "code/app", cols: 120, rows: 40, record: true, remote: true });
  }
  machines.push({ ws, sessions: m.sessions });
}

async function view(sessionId, ticket) {
  const v = { sessionId, seqs: [], syncs: 0, errors: 0, closed: null, latencies: [] };
  const ws = new WebSocket("ws://" + host + "/ws/terminal?ticket=" + encodeURIComponent(ticket), {
    headers: { origin: "http://" + host },
  });
  let pong;
  const ponged = new Promise((resolve) => { pong = resolve; });
  const hello = new Promise((resolve, reject) => {
    ws.on("message", (d) => {
      const f = JSON.parse(d.toString());
      if (f.t === "hello") resolve();
      else if (f.t === "pong") pong();
      else if (f.t === "sync") v.syncs++;
      else if (f.t === "error") v.errors++;
      else if (f.t === "out") {
        const text = Buffer.from(f.data, "base64").toString();
        v.seqs.push(f.seq);
        v.latencies.push(Date.now() - Number(text.slice(0, text.indexOf(";"))));
      }
    });
    ws.once("close", (code) => { v.closed = code; reject(new Error("Đóng " + code)); });
  });
  await hello;
  // Hub xử lý khung của một kết nối theo thứ tự: có pong nghĩa là resume đã xong, người xem đã sẵn sàng nhận output.
  ws.send(JSON.stringify({ t: "resume", after: -1 }));
  ws.send(JSON.stringify({ t: "ping" }));
  await ponged;
  viewers.push({ v, ws });
}

async function stream({ chunks, chunkBytes, intervalMs }) {
  const pad = "x".repeat(chunkBytes);
  const all = machines.flatMap((m) => m.sessions.map((sessionId) => ({ ws: m.ws, sessionId })));
  const start = Date.now();
  // Mỗi phiên lệch pha một chút như CLI thật, không dồn cả 50 phiên vào cùng một khắc.
  await Promise.all(all.map(async ({ ws, sessionId }, k) => {
    for (let seq = 0; seq < chunks; seq++) {
      const wait = start + (k / all.length + seq) * intervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      const head = Date.now() + ";";
      send(ws, { type: "term_output", sessionId, seq, data: Buffer.from(head + pad.slice(head.length)).toString("base64") });
    }
  }));
  const end = Date.now() + 30000;
  while (Date.now() < end && viewers.some(({ v }) => v.seqs.length < chunks && v.syncs === 0 && v.closed === null)) {
    await sleep(50);
  }
  return viewers.map(({ v }) => v);
}

parentPort.on("message", async ({ id, cmd, arg }) => {
  try {
    let result = null;
    if (cmd === "connect") await Promise.all(arg.map(connect));
    if (cmd === "view") await Promise.all(arg.map((x) => view(x.sessionId, x.ticket)));
    if (cmd === "stream") result = await stream(arg);
    if (cmd === "close") for (const c of [...viewers.map((x) => x.ws), ...machines.map((m) => m.ws)]) c.close();
    parentPort.postMessage({ id, result });
  } catch (e) {
    parentPort.postMessage({ id, error: String(e) });
  }
});
`;

interface ViewerStats {
  sessionId: string;
  seqs: number[];
  syncs: number;
  errors: number;
  closed: number | null;
  latencies: number[];
}

let org: OrgFixture & { user: (n: string) => string };
let server: Server;
let host = "";
let clients: Worker;
const closers: Array<() => Promise<void> | void> = [];
const machines: Array<{ token: string; name: string; sessions: string[] }> = [];

let asked = 0;
function ask<T>(cmd: string, arg?: unknown): Promise<T> {
  const id = ++asked;
  return new Promise((resolve, reject) => {
    const onMessage = (m: { id: number; result?: T; error?: string }) => {
      if (m.id !== id) return;
      clients.off("message", onMessage);
      if (m.error) reject(new Error(m.error));
      else resolve(m.result as T);
    };
    clients.on("message", onMessage);
    clients.postMessage({ id, cmd, arg });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * HIVE_TERMINAL_PERF_PROFILE=<file>: CPU profile của luồng hub trong lúc đo, mở bằng DevTools. Cờ `--cpu-prof` không
 * dùng được vì vitest dừng tiến trình test trước khi Node kịp ghi profile.
 */
async function profiled<T>(work: () => Promise<T>): Promise<T> {
  const file = process.env.HIVE_TERMINAL_PERF_PROFILE;
  if (!file) return work();
  const session = new Session();
  session.connect();
  const post = (method: string) =>
    new Promise<unknown>((resolve, reject) => session.post(method, (e, r) => (e ? reject(e) : resolve(r))));
  await post("Profiler.enable");
  await post("Profiler.start");
  try {
    return await work();
  } finally {
    const { profile } = (await post("Profiler.stop")) as { profile: unknown };
    writeFileSync(file, JSON.stringify(profile));
    session.disconnect();
  }
}

/**
 * CPU của luồng hub (% một nhân) và mức bận event loop (0..1) trong `ms`, hay trong lúc `work` chạy. Chỉ ELU thì không
 * đủ: máy bận việc khác làm luồng chờ CPU, ELU lên gần 1 dù hub không tốn thêm gì; CPU của luồng thì không bị ảnh hưởng.
 */
async function busy<T>(ms: number, work?: () => Promise<T>) {
  const elu = performance.eventLoopUtilization();
  const cpu = process.threadCpuUsage();
  const started = performance.now();
  let result: T | undefined;
  if (work) result = await work();
  else await sleep(ms);
  const used = process.threadCpuUsage(cpu);
  const wallMs = performance.now() - started;
  return {
    cpuPct: Math.round(((used.user + used.system) / 1000 / wallMs) * 1000) / 10,
    elu: Math.round(performance.eventLoopUtilization(elu).utilization * 1000) / 1000,
    wallMs,
    result,
  };
}

const percentile = (xs: number[], p: number) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
};

beforeAll(async () => {
  org = await seedOrg(admin, `tperf-${tag}`);
  await admin.query("update hive.team_members set role = 'admin' where team_id = $1 and user_id = $2", [
    org.teamId,
    org.user("tmember"),
  ]);
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const gateway = attachWorkerGateway(server, { pool, heartbeatSec: 60, helloTimeoutMs: 5000 });
  const terminal = attachTerminalGateway(server, { pool, remoteEnabled: true });
  closers.push(registerTerminalHandlers(withRemoteLive(pool, createTerminalHandlers(pool))));
  closers.push(
    () => terminal.close(),
    () => gateway.close(),
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  for (let i = 0; i < MACHINES; i++) {
    const { token } = await withTenant(pool, { userId: org.user("tmember"), orgId: org.orgId }, (tx) =>
      createRegistration(tx, org.user("tmember"), org.teamId),
    );
    const name = `perf-${tag}-${i}`;
    const m = await registerMachine(pool, {
      registrationToken: token,
      machineId: name,
      os: "darwin",
      version: "0.9.0",
      clis: ["claude"],
      capacity: 1,
    });
    machines.push({ token: m.machineToken, name, sessions: Array.from({ length: SESSIONS_PER_MACHINE }, randomUUID) });
  }
  clients = new Worker(CLIENTS, {
    eval: true,
    workerData: { host, proto: PROTOCOL_VERSION, wsPath: createRequire(import.meta.url).resolve("ws") },
  });
  closers.push(async () => {
    await ask("close");
    await clients.terminate();
  });
}, 120_000);

afterAll(async () => {
  for (const close of closers.reverse()) await close();
  await Promise.all([admin.end(), pool.end()]);
});

describe("SC-008: 50 phiên × 3 người xem × 20 KiB/s", () => {
  it("người xem nhanh nhận đủ mọi lát, bản ghi đủ, hub không quá bận", async () => {
    const sessionIds = machines.flatMap((m) => m.sessions);
    await ask("connect", machines);
    const end = Date.now() + 30_000;
    for (;;) {
      const { rows } = await admin.query("select count(*)::int as n from hive.terminal_sessions where id = any($1)", [
        sessionIds,
      ]);
      if (rows[0].n === sessionIds.length) break;
      if (Date.now() > end) throw new Error(`Mới ghi ${rows[0].n}/${sessionIds.length} phiên`);
      await sleep(50);
    }
    const tickets = await withTenant(pool, { userId: org.user("tmember"), orgId: org.orgId }, async (tx) => {
      const out: Array<{ sessionId: string; ticket: string }> = [];
      for (const sessionId of sessionIds) {
        for (let i = 0; i < VIEWERS; i++) {
          const { ticket } = await remoteTicket(tx, org.user("tmember"), org.orgId, sessionId, { enabled: true });
          out.push({ sessionId, ticket });
        }
      }
      return out;
    });
    await ask("view", tickets);

    const idle = await busy(2000);
    const run = await busy(0, () =>
      profiled(() =>
        ask<ViewerStats[]>("stream", { chunks: CHUNKS, chunkBytes: CHUNK_BYTES, intervalMs: INTERVAL_MS }),
      ),
    );
    const viewers = run.result ?? [];

    const latencies = viewers.flatMap((v) => v.latencies);
    const report = {
      sessions: sessionIds.length,
      viewers: viewers.length,
      bytesPerSessionPerSec: (CHUNK_BYTES * 1000) / INTERVAL_MS,
      hubCpuPct: { idle: idle.cpuPct, stream: run.cpuPct },
      elu: { idle: idle.elu, stream: run.elu },
      streamMs: Math.round(run.wallMs),
      latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: percentile(latencies, 1) },
    };
    console.info(`SC-008 ${JSON.stringify(report)}`);
    if (process.env.HIVE_TERMINAL_PERF_REPORT) {
      writeFileSync(process.env.HIVE_TERMINAL_PERF_REPORT, JSON.stringify(report, null, 2));
    }

    expect(viewers).toHaveLength(sessionIds.length * VIEWERS);
    const want = Array.from({ length: CHUNKS }, (_, i) => i);
    for (const v of viewers) {
      expect({ sessionId: v.sessionId, syncs: v.syncs, errors: v.errors, closed: v.closed, seqs: v.seqs }).toEqual({
        sessionId: v.sessionId,
        syncs: 0,
        errors: 0,
        closed: null,
        seqs: want,
      });
    }
    const { rows } = await admin.query(
      "select count(*)::int as n from hive.terminal_chunks where session_id = any($1)",
      [sessionIds],
    );
    expect(rows[0].n).toBe(sessionIds.length * CHUNKS);
    expect(run.cpuPct - idle.cpuPct).toBeLessThan(CPU_CEILING_PCT);
  }, 180_000);
});
