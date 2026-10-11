import { TERMINAL_RUN_STATES } from "@xdev-hive/contracts";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type pg from "pg";
import type { Auth } from "../identity/index.ts";
import { ForbiddenError, NotFoundError, withTenant } from "../platform/index.ts";
import { ORG_HEADER } from "../tenancy/index.ts";
import { runForUser } from "./engine.ts";
import { eventsAfter, logsAfter } from "./queries.ts";
import { runs } from "./schema.ts";
import { RUNS_CHANNEL } from "./state.ts";

/**
 * Một kết nối LISTEN cho cả tiến trình api, phát lại trong bộ nhớ cho các luồng SSE (docs/architecture.md mục 9).
 * Mượn kết nối từ pool lúc có người nghe đầu tiên và giữ luôn; mất kết nối thì nối lại, luồng SSE vẫn tự đọc lại định
 * kỳ nên không mất dữ liệu trong lúc nối lại.
 */
export class RunNotifier {
  private client: pg.PoolClient | null = null;
  private connecting: Promise<void> | null = null;
  private readonly listeners = new Map<string, Set<() => void>>();
  private closed = false;
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  subscribe(runId: string, fn: () => void): () => void {
    let set = this.listeners.get(runId);
    if (!set) {
      set = new Set();
      this.listeners.set(runId, set);
    }
    set.add(fn);
    void this.ensure();
    return () => {
      set.delete(fn);
      if (set.size === 0) this.listeners.delete(runId);
    };
  }

  /** Chờ tới khi LISTEN đã chạy (test dùng để không lỡ NOTIFY đầu tiên). */
  ready(): Promise<void> {
    return this.ensure();
  }

  private ensure(): Promise<void> {
    if (this.client || this.closed) return Promise.resolve();
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    const client = await this.pool.connect();
    client.on("notification", (n) => {
      if (n.channel !== RUNS_CHANNEL || !n.payload) return;
      for (const fn of this.listeners.get(n.payload) ?? []) fn();
    });
    client.on("error", () => {
      client.release(true);
      if (this.client === client) this.client = null;
      if (!this.closed) setTimeout(() => void this.ensure(), 1000).unref();
    });
    await client.query(`listen ${RUNS_CHANNEL}`);
    if (this.closed) {
      client.release(true);
      return;
    }
    this.client = client;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.connecting?.catch(() => {});
    const client = this.client;
    this.client = null;
    if (client) {
      await client.query(`unlisten ${RUNS_CHANNEL}`).catch(() => {});
      client.release(true);
    }
  }
}

export interface RunStreamDeps {
  auth?: Auth | undefined;
  pool?: pg.Pool | undefined;
  notifier?: RunNotifier | undefined;
  /** Đọc lại dù không có NOTIFY, phòng lỡ thông báo khi kết nối LISTEN đang nối lại. */
  pollMs?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = 200;

/** Con trỏ SSE gộp hai dãy id (sự kiện, log) thành `<eventId>.<logId>`, để Last-Event-ID nối tiếp được cả hai. */
export function parseCursor(raw: string | undefined | null): { e: number; l: number } {
  const m = /^(\d{1,18})\.(\d{1,18})$/.exec(raw ?? "");
  return m ? { e: Number(m[1]), l: Number(m[2]) } : { e: 0, l: 0 };
}

/**
 * GET /api/v1/runs/{id}/stream: SSE phát `run_event` và `log` mới của run, kết thúc bằng `end` khi run xong. Tổ chức
 * lấy từ header x-hive-org hoặc tham số `org` (EventSource của trình duyệt không đặt được header).
 */
export function runStreamHandler(deps: RunStreamDeps) {
  const pollMs = deps.pollMs ?? 15_000;
  return async (c: Context) => {
    const session = deps.auth ? await deps.auth.api.getSession({ headers: c.req.raw.headers }) : null;
    if (!session) return c.json({ message: "Chưa đăng nhập." }, 401);
    const { pool, notifier } = deps;
    if (!pool || !notifier) return c.json({ message: "Hub chưa cấu hình HIVE_DATABASE_URL." }, 500);
    const orgId = c.req.header(ORG_HEADER) ?? c.req.query("org");
    if (!orgId || !UUID.test(orgId)) return c.json({ message: `Chưa chọn tổ chức (header ${ORG_HEADER}).` }, 400);
    const runId = c.req.param("id") ?? "";
    if (!UUID.test(runId)) return c.json({ message: "Không tìm thấy run trong tổ chức." }, 404);
    const userId = session.user.id;
    const inOrg = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(pool, { userId, orgId }, fn);
    try {
      await inOrg((tx) => runForUser(tx, userId, runId, "viewer"));
    } catch (e) {
      if (e instanceof NotFoundError) return c.json({ message: e.message, data: { code: e.code } }, 404);
      if (e instanceof ForbiddenError) return c.json({ message: e.message, data: { code: e.code } }, 403);
      throw e;
    }
    let cursor = parseCursor(c.req.header("last-event-id") ?? c.req.query("lastEventId"));

    return streamSSE(c, async (stream) => {
      let dirty = true;
      let wake: (() => void) | null = null;
      const poke = () => {
        dirty = true;
        wake?.();
      };
      const unsubscribe = notifier.subscribe(runId, poke);
      stream.onAbort(() => {
        unsubscribe();
        poke();
      });
      await notifier.ready().catch(() => {});
      try {
        while (!stream.aborted) {
          dirty = false;
          const { events, logs, state } = await inOrg(async (tx) => {
            const [row] = await tx.select({ state: runs.state }).from(runs).where(eq(runs.id, runId));
            return {
              events: await eventsAfter(tx, runId, cursor.e, PAGE),
              logs: await logsAfter(tx, runId, cursor.l, PAGE),
              state: row?.state,
            };
          });
          for (const ev of events) {
            cursor = { ...cursor, e: ev.id };
            await stream.writeSSE({ id: `${cursor.e}.${cursor.l}`, event: "run_event", data: JSON.stringify(ev) });
          }
          for (const chunk of logs) {
            cursor = { ...cursor, l: chunk.id };
            await stream.writeSSE({ id: `${cursor.e}.${cursor.l}`, event: "log", data: JSON.stringify(chunk) });
          }
          if (events.length === PAGE || logs.length === PAGE) continue;
          // Run đã xong và đã gửi hết: đóng luồng, để client không giữ kết nối vô ích.
          if (!state || TERMINAL_RUN_STATES.includes(state)) {
            await stream.writeSSE({ event: "end", data: JSON.stringify({ state: state ?? null }) });
            break;
          }
          if (dirty) continue;
          const timedOut = await new Promise<boolean>((resolve) => {
            const t = setTimeout(() => resolve(true), pollMs);
            wake = () => {
              clearTimeout(t);
              resolve(false);
            };
          });
          wake = null;
          // Dòng chú thích giữ kết nối qua proxy hay cắt luồng im lặng.
          if (timedOut && !stream.aborted) await stream.write(": ping\n\n");
        }
      } finally {
        unsubscribe();
      }
    });
  };
}
