import type { IssueIntake } from "@xdev-hive/contracts";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { type Jobs, withTenant } from "../platform/index.ts";
import { normalizeEvent, rawEventName } from "./events.ts";
import { SCM_EVENT_QUEUE, type ScmEventJob } from "./handlers.ts";
import { webhookDeliveries } from "./schema.ts";
import type { GitProviderKind } from "./types.ts";
import { deliveryId, eventHeader, verifyWebhook } from "./verify.ts";

/** Dự án nhận webhook, kèm secret đã giải mã. Chỉ sống trong bộ nhớ trong lúc xử lý một request. */
export interface WebhookTarget {
  orgId: string;
  projectId: string;
  provider: GitProviderKind;
  secret: string;
  intake: IssueIntake;
}

/**
 * Tìm dự án theo id trên URL, khi chưa biết tổ chức. Module catalog cung cấp (bảng projects là của nó); app.ts nối
 * vào đây, vì scm không import ngược catalog (catalog đã import scm).
 */
export type WebhookTargetResolver = (projectId: string) => Promise<WebhookTarget | null>;

export interface WebhookDeps {
  pool?: pg.Pool | undefined;
  jobs?: Jobs | undefined;
  resolveTarget?: WebhookTargetResolver | undefined;
  /** GitHub cắt payload ở 25 MB; lớn hơn thì chắc chắn không phải webhook thật. */
  maxBodyBytes?: number | undefined;
}

const MAX_BODY = 25 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const reply = (status: number, body: Record<string, unknown>) => Response.json(body, { status });
const failure = (status: number, code: string, message: string) => reply(status, { error: { code, message } });
// Cùng một câu cho dự án không có, chưa bật webhook và chữ ký sai: không cho người ngoài dò id dự án.
const unauthorized = () => failure(401, "WEBHOOK_UNAUTHORIZED", "Chữ ký webhook không hợp lệ.");

async function readBody(req: Request, limit: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > limit) return null;
  const body = new Uint8Array(await req.arrayBuffer());
  return body.byteLength > limit ? null : body;
}

/**
 * POST /hooks/git/{projectId}. Kiểm chữ ký trước khi ghi bất cứ gì; ghi delivery và gửi job trong một transaction
 * rồi trả 202 ngay, việc nặng để vai trò `jobs` làm. Nhà cung cấp gửi lại cùng mã giao nhận thì trả 200, không ghi.
 */
export async function handleGitWebhook(deps: WebhookDeps, projectId: string, req: Request): Promise<Response> {
  const { pool, jobs, resolveTarget } = deps;
  if (!pool || !resolveTarget) {
    return failure(503, "WEBHOOK_DISABLED", "Hub chưa cấu hình database nên chưa nhận được webhook.");
  }
  const body = await readBody(req, deps.maxBodyBytes ?? MAX_BODY);
  if (!body) return failure(413, "WEBHOOK_TOO_LARGE", "Payload webhook quá lớn.");
  if (!UUID.test(projectId)) return unauthorized();
  const target = await resolveTarget(projectId.toLowerCase());
  if (!target || !verifyWebhook(target.provider, target.secret, body, req.headers)) return unauthorized();

  const id = deliveryId(target.provider, req.headers);
  const event = eventHeader(target.provider, req.headers);
  if (!id || !event) return failure(400, "WEBHOOK_HEADERS_MISSING", "Thiếu header mã giao nhận hoặc loại sự kiện.");
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return failure(
      400,
      "WEBHOOK_BAD_PAYLOAD",
      "Payload webhook không phải JSON. Đặt Content type là application/json.",
    );
  }
  const events = normalizeEvent(target.provider, event, payload, { mention: target.intake.mention });
  if (events.length > 0 && !jobs) {
    // Không ghi delivery: trả lỗi để nhà cung cấp gửi lại khi hub đã bật hàng đợi.
    return failure(503, "JOBS_DISABLED", "Hub chưa bật hàng đợi (HIVE_DATABASE_JOBS_URL) nên chưa xử lý được webhook.");
  }

  const result = await withTenant(pool, { orgId: target.orgId }, async (tx) => {
    // Ràng buộc duy nhất (provider, delivery_id) quyết định trùng, kể cả khi hai lần gửi tới cùng lúc.
    const [row] = await tx
      .insert(webhookDeliveries)
      .values({
        orgId: sql`hive.ctx_org()`,
        projectId: target.projectId,
        provider: target.provider,
        deliveryId: id,
        event: rawEventName(target.provider, event, payload).slice(0, 200),
        status: events.length > 0 ? "queued" : "ignored",
        processedAt: events.length > 0 ? null : sql`now()`,
      })
      .onConflictDoNothing({ target: [webhookDeliveries.provider, webhookDeliveries.deliveryId] })
      .returning({ id: webhookDeliveries.id });
    if (!row) return { duplicate: true as const };
    if (events.length > 0 && jobs) {
      const job: ScmEventJob = {
        orgId: target.orgId,
        projectId: target.projectId,
        deliveryRowId: row.id,
        provider: target.provider,
        events,
        intake: target.intake,
      };
      await jobs.enqueue(SCM_EVENT_QUEUE, job, { tx });
    }
    return { duplicate: false as const, id: row.id };
  });

  if (result.duplicate) return reply(200, { status: "duplicate" });
  return reply(202, {
    status: events.length > 0 ? "queued" : "ignored",
    deliveryId: result.id,
    events: events.map((e) => e.kind),
  });
}
