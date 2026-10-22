import { DEPLOY_ACTIVE_STATES, type DeployStep } from "@xdev-hive/contracts";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type pg from "pg";
import { loadProject } from "../catalog/index.ts";
import type { Auth } from "../identity/index.ts";
import { type Tx, withTenant } from "../platform/index.ts";
import { effectivePermissions, ORG_HEADER } from "../tenancy/index.ts";
import { DEPLOY_LOG_CHANNEL, logsAfter } from "./logs.ts";
import { deploys, deployTargets } from "./schema.ts";

/**
 * Một kết nối LISTEN cho cả tiến trình api, phát lại trong bộ nhớ cho các luồng SSE (docs/architecture.md mục 9), như
 * `RunNotifier` của runs nhưng trên kênh riêng của lần triển khai. Mất kết nối thì nối lại; luồng SSE vẫn tự đọc lại
 * định kỳ nên không mất dữ liệu trong lúc nối lại.
 */
export class DeployLogNotifier {
  private client: pg.PoolClient | null = null;
  private connecting: Promise<void> | null = null;
  private readonly listeners = new Map<string, Set<() => void>>();
  private closed = false;
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  subscribe(deployId: string, fn: () => void): () => void {
    let set = this.listeners.get(deployId);
    if (!set) {
      set = new Set();
      this.listeners.set(deployId, set);
    }
    set.add(fn);
    void this.ensure().catch(() => {});
    return () => {
      set.delete(fn);
      if (set.size === 0) this.listeners.delete(deployId);
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
      if (n.channel !== DEPLOY_LOG_CHANNEL || !n.payload) return;
      for (const fn of this.listeners.get(n.payload) ?? []) fn();
    });
    client.on("error", () => {
      client.release(true);
      if (this.client === client) this.client = null;
      if (!this.closed) setTimeout(() => void this.ensure().catch(() => {}), 1000).unref();
    });
    await client.query(`listen ${DEPLOY_LOG_CHANNEL}`);
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
      await client.query(`unlisten ${DEPLOY_LOG_CHANNEL}`).catch(() => {});
      client.release(true);
    }
  }
}

export interface DeployStreamDeps {
  auth?: Auth | undefined;
  pool?: pg.Pool | undefined;
  notifier?: DeployLogNotifier | undefined;
  /** Đọc lại dù không có NOTIFY, phòng lỡ thông báo và để phát hiện lần triển khai đã xong. */
  pollMs?: number | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = 200;

/** Con trỏ SSE là id của đoạn log đã nhận cuối cùng; không hợp lệ thì đọc từ đầu. */
export function parseDeployCursor(raw: string | undefined | null): number {
  return /^\d{1,18}$/.test(raw ?? "") ? Number(raw) : 0;
}

interface DeploySnapshot {
  state: string;
  steps: DeployStep[];
}

/**
 * Ai xem được log triển khai spec không nói; tạm dùng `ci.view` của đội sở hữu dự án **[Suy luận]**. Không thấy hoặc
 * thiếu quyền đều là "không tìm thấy", để không lộ id lần triển khai của đội khác.
 */
async function viewable(tx: Tx, userId: string, deployId: string): Promise<DeploySnapshot | null> {
  const [row] = await tx
    .select({ state: deploys.state, steps: deploys.steps, projectId: deployTargets.projectId })
    .from(deploys)
    .innerJoin(deployTargets, eq(deployTargets.id, deploys.targetId))
    .where(eq(deploys.id, deployId));
  if (!row) return null;
  const project = await loadProject(tx, row.projectId);
  if (!project) return null;
  if (!(await effectivePermissions(tx, userId, project.teamId)).has("ci.view")) return null;
  return { state: row.state, steps: row.steps };
}

/**
 * GET /api/v1/deploys/{id}/stream: SSE `steps` (trạng thái và các bước, khi đổi), `log` (đoạn log mới) và `end` khi lần
 * triển khai không còn đang đi. Nằm ngoài oRPC như luồng của run vì cần Last-Event-ID: `id` của sự kiện `log` là id đoạn
 * log, nên nối lại với `Last-Event-ID` thì đọc tiếp đúng chỗ. Tổ chức lấy từ header x-hive-org hoặc tham số `org`.
 */
export function deployStreamHandler(deps: DeployStreamDeps) {
  const pollMs = deps.pollMs ?? 15_000;
  const notifier = deps.notifier ?? (deps.pool ? new DeployLogNotifier(deps.pool) : undefined);
  return async (c: Context) => {
    const session = deps.auth ? await deps.auth.api.getSession({ headers: c.req.raw.headers }) : null;
    if (!session) return c.json({ message: "Chưa đăng nhập." }, 401);
    const { pool } = deps;
    if (!pool || !notifier) return c.json({ message: "Hub chưa cấu hình HIVE_DATABASE_URL." }, 500);
    const orgId = c.req.header(ORG_HEADER) ?? c.req.query("org");
    if (!orgId || !UUID.test(orgId)) return c.json({ message: `Chưa chọn tổ chức (header ${ORG_HEADER}).` }, 400);
    const deployId = c.req.param("id") ?? "";
    const notFound = () => c.json({ message: "Không tìm thấy lần triển khai.", data: { code: "NOT_FOUND" } }, 404);
    if (!UUID.test(deployId)) return notFound();
    const userId = session.user.id;
    const inOrg = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(pool, { userId, orgId }, fn);
    if (!(await inOrg((tx) => viewable(tx, userId, deployId)))) return notFound();

    let cursor = parseDeployCursor(c.req.header("last-event-id") ?? c.req.query("lastEventId"));
    let sentSteps = "";

    return streamSSE(c, async (stream) => {
      let dirty = true;
      let wake: (() => void) | null = null;
      const poke = () => {
        dirty = true;
        wake?.();
      };
      const unsubscribe = notifier.subscribe(deployId, poke);
      stream.onAbort(() => {
        unsubscribe();
        poke();
      });
      await notifier.ready().catch(() => {});
      try {
        while (!stream.aborted) {
          dirty = false;
          const { snapshot, logs } = await inOrg(async (tx) => ({
            // Đọc trạng thái trước log: lần triển khai xong sau khi ta đọc trạng thái thì log của nó đã nằm trong lần
            // đọc kế tiếp, không bao giờ kết thúc luồng mà còn sót log chưa gửi.
            snapshot: await viewable(tx, userId, deployId),
            logs: await logsAfter(tx, deployId, cursor, PAGE),
          }));
          if (snapshot) {
            const steps = JSON.stringify({ state: snapshot.state, steps: snapshot.steps });
            if (steps !== sentSteps) {
              sentSteps = steps;
              await stream.writeSSE({ id: String(cursor), event: "steps", data: steps });
            }
          }
          for (const chunk of logs) {
            cursor = chunk.id;
            await stream.writeSSE({ id: String(cursor), event: "log", data: JSON.stringify(chunk) });
          }
          if (logs.length === PAGE) continue;
          // Đã xong và đã gửi hết (hoặc lần triển khai bị xoá): đóng luồng để client không giữ kết nối vô ích.
          if (!snapshot || !(DEPLOY_ACTIVE_STATES as readonly string[]).includes(snapshot.state)) {
            await stream.writeSSE({ event: "end", data: JSON.stringify({ state: snapshot?.state ?? null }) });
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
