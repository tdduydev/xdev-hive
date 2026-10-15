import { eq, sql } from "drizzle-orm";
import { decryptSecret, withTenant } from "../platform/index.ts";
import { verifyGitHubSignature, verifyGitLabToken } from "../scm/index.ts";
import { homeSecretContext } from "./homes.ts";
import { queuePull } from "./jobs.ts";
import type { DocSyncDeps } from "./routes/deps.ts";
import { docHomes } from "./schema.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 25 * 1024 * 1024;

const reply = (status: number, body: Record<string, unknown>) => Response.json(body, { status });
// Một câu cho nhà không có, chưa gắn webhook và chữ ký sai: không cho người ngoài dò id nhà.
const unauthorized = () =>
  reply(401, { error: { code: "WEBHOOK_UNAUTHORIZED", message: "Chữ ký webhook không hợp lệ." } });

/** Sự kiện đáng kéo lại: push, và PR/MR (PR đóng không merge cần đưa file về "pending"). */
const PULL_EVENTS = new Set(["push", "pull_request", "Push Hook", "Merge Request Hook"]);

/**
 * POST /hooks/docs/{homeId}. Kiểm chữ ký trước khi tin bất cứ gì, rồi xếp một
 * lần kéo cho nhà. Việc kéo nằm ở job (T014), nên đây trả 202 ngay.
 */
export async function handleDocsWebhook(deps: DocSyncDeps, homeId: string, request: Request): Promise<Response> {
  const { pool, jobs, masterKey } = deps;
  if (!pool || !masterKey) {
    return reply(503, { error: { code: "WEBHOOK_DISABLED", message: "Hub chưa cấu hình database hoặc khoá chủ." } });
  }
  if (!UUID.test(homeId)) return unauthorized();
  const id = homeId.toLowerCase();
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY) return reply(413, { error: { code: "WEBHOOK_TOO_LARGE", message: "Payload quá lớn." } });
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > MAX_BODY) {
    return reply(413, { error: { code: "WEBHOOK_TOO_LARGE", message: "Payload quá lớn." } });
  }

  const home = await withTenant(pool, {}, async (tx) => {
    await tx.execute(sql`select set_config('app.webhook_doc_home_id', ${id}, true)`);
    const [row] = await tx.select().from(docHomes).where(eq(docHomes.id, id));
    return row ?? null;
  });
  if (!home?.webhookSecretEnc || !home.webhookId) return unauthorized();

  const secret = decryptSecret(masterKey, home.webhookSecretEnc, homeSecretContext(home.id));
  const github = request.headers.get("x-hub-signature-256");
  const signed = github
    ? verifyGitHubSignature(secret, body, github)
    : verifyGitLabToken(secret, request.headers.get("x-gitlab-token"));
  if (!signed) return unauthorized();

  const event = request.headers.get("x-github-event") ?? request.headers.get("x-gitlab-event") ?? "";
  if (!event) {
    return reply(400, { error: { code: "WEBHOOK_HEADERS_MISSING", message: "Thiếu header loại sự kiện." } });
  }
  if (event === "ping") return new Response(null, { status: 204 });

  const wanted = PULL_EVENTS.has(event) && home.status === "active" && home.mode !== "off";
  if (wanted && !jobs) {
    // Trả lỗi để nhà cung cấp gửi lại khi hub đã bật hàng đợi.
    return reply(503, {
      error: { code: "JOBS_DISABLED", message: "Hub chưa bật hàng đợi nên chưa xử lý được webhook." },
    });
  }

  // Không ghi webhook_deliveries: bảng đó khoá ngoại tới dự án, mà nhà tổ chức không thuộc dự án nào. Gửi lại cùng mã
  // giao nhận vô hại vì job kéo có singletonKey theo nhà và kéo lại không đổi gì khi nhánh chưa tiến.
  if (wanted && jobs)
    await withTenant(pool, { orgId: home.orgId }, (tx) =>
      queuePull(jobs, { orgId: home.orgId, homeId: home.id }, { tx }),
    );
  return reply(202, { status: wanted ? "queued" : "ignored" });
}
