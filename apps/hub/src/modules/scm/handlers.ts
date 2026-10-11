import type { IssueIntake } from "@xdev-hive/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import type pg from "pg";
import { recordAudit } from "../audit/index.ts";
import { type Jobs, type Tx, withTenant } from "../platform/index.ts";
import type { ScmEvent, ScmEventKind } from "./events.ts";
import { webhookDeliveries } from "./schema.ts";
import type { GitProviderKind } from "./types.ts";

export const SCM_EVENT_QUEUE = "scm.event";

export const scmEventQueue = {
  name: SCM_EVENT_QUEUE,
  // Lỗi của handler (database bận, module khác lỗi tạm) thử lại vài lần; quá số lần thì delivery ở `failed`.
  retryLimit: 5,
  retryDelay: 30,
  retryBackoff: true,
  expireInSeconds: 5 * 60,
} as const;

/** Payload của job: sự kiện đã chuẩn hoá, không mang payload gốc (có thể vài MB) vào hàng đợi. */
export interface ScmEventJob {
  orgId: string;
  projectId: string;
  /** Id dòng webhook_deliveries. */
  deliveryRowId: string;
  provider: GitProviderKind;
  events: ScmEvent[];
  /** Cấu hình giao việc từ issue của dự án lúc nhận webhook. */
  intake: IssueIntake;
}

export interface ScmEventContext {
  /** Transaction có tenant là tổ chức của dự án. Mọi handler của một delivery chạy chung, cùng commit hoặc rollback. */
  tx: Tx;
  orgId: string;
  projectId: string;
  deliveryRowId: string;
  intake: IssueIntake;
}

/**
 * Handler phải idempotent: một handler lỗi thì cả delivery rollback và pg-boss chạy lại mọi handler của nó.
 */
export type ScmEventHandler<K extends ScmEventKind = ScmEventKind> = (
  // Giao chứ không Extract: PullRequestEvent gom ba loại PR nên Extract theo một loại ra never.
  event: ScmEvent & { kind: K },
  ctx: ScmEventContext,
) => Promise<void>;

/** Handler đã xoá kiểu theo loại: registry chỉ gọi handler với sự kiện đúng loại nó đăng ký. */
type AnyScmEventHandler = (event: ScmEvent, ctx: ScmEventContext) => Promise<void>;

export interface ScmEventRegistry {
  /** Đăng ký handler cho một loại sự kiện, hoặc `*` cho mọi loại. Trả hàm huỷ đăng ký. */
  on<K extends ScmEventKind>(kind: K, handler: ScmEventHandler<NoInfer<K>>): () => void;
  on(kind: "*", handler: ScmEventHandler): () => void;
  handlersFor(kind: ScmEventKind): AnyScmEventHandler[];
}

export function createScmEventRegistry(): ScmEventRegistry {
  const byKind = new Map<ScmEventKind | "*", Set<AnyScmEventHandler>>();
  return {
    on(kind: ScmEventKind | "*", handler: ScmEventHandler) {
      const set = byKind.get(kind) ?? new Set();
      byKind.set(kind, set);
      const h = handler as unknown as AnyScmEventHandler;
      set.add(h);
      return () => set.delete(h);
    },
    handlersFor(kind) {
      return [...(byKind.get(kind) ?? []), ...(byKind.get("*") ?? [])];
    },
  };
}

/**
 * Bảng đăng ký dùng chung của tiến trình. Module khác đăng ký lúc khởi động vai trò `jobs`, nên không cần truyền
 * registry qua từng lớp; test dùng createScmEventRegistry() để không lẫn handler giữa các file.
 */
export const scmEvents = createScmEventRegistry();

export function onScmEvent<K extends ScmEventKind>(kind: K, handler: ScmEventHandler<NoInfer<K>>): () => void;
export function onScmEvent(kind: "*", handler: ScmEventHandler): () => void;
export function onScmEvent(kind: ScmEventKind | "*", handler: ScmEventHandler): () => void {
  return scmEvents.on(kind as "*", handler);
}

/** Tóm tắt đủ để tra cứu, không chép nội dung issue hay bình luận vào nhật ký. */
function summary(e: ScmEvent): Record<string, unknown> {
  const base = { provider: e.provider, repo: e.repo, actor: e.actor };
  switch (e.kind) {
    case "pull_request.opened":
    case "pull_request.closed":
    case "pull_request.merged":
      return { ...base, number: e.pullRequest.number, head: e.pullRequest.head, base: e.pullRequest.base };
    case "push":
      return { ...base, branch: e.branch, sha: e.sha };
    case "issue.opened":
      return { ...base, number: e.issue.number, labels: e.issue.labels };
    case "issue.labeled":
      return { ...base, number: e.issue.number, label: e.label };
    case "issue.commented":
      return { ...base, number: e.issue.number, commentId: e.comment.id };
    case "comment.mentioned":
      return { ...base, target: e.target.type, number: e.target.number, commentId: e.comment.id };
  }
}

/** Handler mẫu: ghi mỗi sự kiện vào audit. Module tasks/runs đăng ký handler của mình theo cùng cách. */
export const auditScmEvent: ScmEventHandler = async (event, ctx) => {
  await recordAudit(ctx.tx, {
    action: `scm.${event.kind}`,
    actorUserId: null,
    targetType: "project",
    targetId: ctx.projectId,
    data: { deliveryRowId: ctx.deliveryRowId, ...summary(event) },
  });
};

export type ScmJobOutcome = "processed" | "skipped";

/** Chạy mọi handler đã đăng ký cho các sự kiện của một delivery, rồi đánh dấu delivery đã xử lý. */
export async function processScmEventJob(
  pool: pg.Pool,
  registry: ScmEventRegistry,
  job: ScmEventJob,
): Promise<ScmJobOutcome> {
  try {
    return await withTenant(pool, { orgId: job.orgId }, async (tx) => {
      // Khoá dòng: pg-boss giao lại job (tiến trình chết sau commit, trước khi báo xong) thì lần sau chờ rồi thấy
      // `processed` và bỏ qua, không chạy handler hai lần.
      const [row] = await tx
        .select({ status: webhookDeliveries.status })
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, job.deliveryRowId))
        .for("update");
      if (!row || row.status === "processed" || row.status === "ignored") return "skipped";
      const ctx: ScmEventContext = {
        tx,
        orgId: job.orgId,
        projectId: job.projectId,
        deliveryRowId: job.deliveryRowId,
        intake: job.intake,
      };
      for (const event of job.events) {
        for (const handler of registry.handlersFor(event.kind)) await handler(event, ctx);
      }
      await tx
        .update(webhookDeliveries)
        .set({ status: "processed", processedAt: sql`now()`, error: null })
        .where(eq(webhookDeliveries.id, job.deliveryRowId));
      return "processed";
    });
  } catch (e) {
    // Transaction của handler đã rollback; ghi lỗi trong transaction riêng để màn quản trị thấy vì sao chưa xử lý.
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
    await withTenant(pool, { orgId: job.orgId }, (tx) =>
      tx
        .update(webhookDeliveries)
        .set({ status: "failed", error: message })
        .where(
          and(eq(webhookDeliveries.id, job.deliveryRowId), inArray(webhookDeliveries.status, ["queued", "failed"])),
        ),
    ).catch(() => {});
    throw e;
  }
}

/** Đăng ký xử lý job `scm.event` ở tiến trình có vai trò `jobs`. */
export async function registerScmEventWorker(
  jobs: Jobs,
  deps: { pool: pg.Pool; registry?: ScmEventRegistry | undefined },
  opts: { pollingIntervalSeconds?: number } = {},
) {
  const registry = deps.registry ?? scmEvents;
  await jobs.work<ScmEventJob>(
    SCM_EVENT_QUEUE,
    async (job) => {
      await processScmEventJob(deps.pool, registry, job.data);
    },
    opts,
  );
}
