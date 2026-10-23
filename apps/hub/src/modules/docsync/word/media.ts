import { and, eq } from "drizzle-orm";
import { createPostgresBlobStore, ForbiddenError, NotFoundError, withTenant } from "../../platform/index.ts";
import { ORG_HEADER, requireOrgRole, tokenOrgMismatch } from "../../tenancy/index.ts";
import { loadVisible } from "../routes/word-imports.ts";
import { docWordImportFiles } from "../schema.ts";
import { canReviewStaged } from "./staging.ts";
import type { WordHttpDeps } from "./tools.ts";

export interface WordMediaParams {
  importId: string;
  fileId: string;
  name: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Như đính kèm (assets.ts): SVG/HTML mở thẳng sẽ chạy như trang cùng origin với hub nên luôn ép tải về.
const ACTIVE_TYPES = new Set(["image/svg+xml", "text/html", "application/xhtml+xml", "text/xml", "application/xml"]);

const reply = (status: number, message: string, code: string) =>
  Response.json({ defined: false, code, status, message }, { status });
const notFound = () => reply(404, "Không tìm thấy ảnh của file trong lượt nhập Word.", "NOT_FOUND");

function contentDisposition(name: string, mediaType: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const kind = ACTIVE_TYPES.has(mediaType) ? "attachment" : "inline";
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * `GET /api/v1/docs/word-imports/:importId/files/:fileId/media/:name`: ảnh giữ tạm để xem trước (plan.md mục 5). Chỉ
 * người tạo lượt, người `manage` ở phạm vi đích và người duyệt đề xuất của file (plan.md mục 9) xem được. Tổ chức lấy
 * từ header hoặc tham số `org` vì thẻ <img> không đặt được header.
 */
export async function handleWordMedia(
  deps: WordHttpDeps,
  request: Request,
  params: WordMediaParams,
): Promise<Response> {
  const session = deps.auth ? await deps.auth.api.getSession({ headers: request.headers }) : null;
  if (!session) return reply(401, "Chưa đăng nhập.", "UNAUTHORIZED");
  if (!deps.pool) return reply(500, "Hub chưa cấu hình HIVE_DATABASE_URL.", "INTERNAL_SERVER_ERROR");
  const orgId = request.headers.get(ORG_HEADER) ?? new URL(request.url).searchParams.get("org");
  if (!orgId || !UUID.test(orgId)) return reply(400, `Chưa chọn tổ chức (header ${ORG_HEADER}).`, "BAD_REQUEST");
  if (tokenOrgMismatch(session, orgId)) return reply(401, "Chưa đăng nhập.", "UNAUTHORIZED");
  if (!UUID.test(params.importId) || !UUID.test(params.fileId)) return notFound();
  const ctx = { userId: session.user.id, orgId };
  const blobStore = deps.blobStore ?? createPostgresBlobStore();
  try {
    // Ảnh xem trước nhỏ (đã qua giới hạn giải nén) nên đọc hết trong cùng transaction với bước kiểm quyền.
    const found = await withTenant(deps.pool, ctx, async (tx) => {
      await requireOrgRole(tx, ctx.userId, "member");
      const principal = { kind: "user" as const, userId: ctx.userId };
      const visible = await loadVisible(tx, principal, params.importId).then(
        () => true,
        (error) => {
          if (error instanceof NotFoundError) return false;
          throw error;
        },
      );
      const [file] = await tx
        .select()
        .from(docWordImportFiles)
        .where(and(eq(docWordImportFiles.id, params.fileId), eq(docWordImportFiles.importId, params.importId)));
      if (!file || !(visible || (await canReviewStaged(tx, principal, file)))) return null;
      const image = file.images.find((i) => i.name === params.name);
      if (!image) return null;
      const chunks: Uint8Array[] = [];
      for await (const chunk of await blobStore.get(tx, orgId, image.blobId)) chunks.push(chunk);
      return { image, body: Buffer.concat(chunks) };
    });
    if (!found) return notFound();
    // Tên ảnh là 12 ký tự đầu SHA-256 của nội dung nên dùng được làm ETag.
    const etag = `"${found.image.name}"`;
    const headers = new Headers({
      "Content-Type": found.image.mediaType,
      "Content-Disposition": contentDisposition(found.image.name, found.image.mediaType),
      "Cache-Control": "private, max-age=300",
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
    });
    if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
    headers.set("Content-Length", String(found.body.byteLength));
    return new Response(found.body, { status: 200, headers });
  } catch (error) {
    // Không có quyền cũng trả 404 như lượt không tồn tại, để không lộ lượt nhập của người khác.
    if (error instanceof NotFoundError) return notFound();
    if (error instanceof ForbiddenError) return reply(403, error.message, "FORBIDDEN");
    throw error;
  }
}
