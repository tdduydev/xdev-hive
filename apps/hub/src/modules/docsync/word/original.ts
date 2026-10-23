import { and, eq } from "drizzle-orm";
import { recordAudit } from "../../audit/index.ts";
import { createPostgresBlobStore, ForbiddenError, NotFoundError, withTenant } from "../../platform/index.ts";
import { ORG_HEADER, requireOrgRole, tokenOrgMismatch } from "../../tenancy/index.ts";
import { canReadDoc } from "../routes/word-imports.ts";
import { docWordImportFiles } from "../schema.ts";
import type { WordHttpDeps } from "./tools.ts";

export interface WordOriginalParams {
  importId: string;
  fileId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEDIA_TYPES: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
};

const reply = (status: number, message: string, code: string) =>
  Response.json({ defined: false, code, status, message }, { status });
// Một thông báo cho mọi lý do không tải được, để người không có quyền không biết lượt hay file có tồn tại.
const notFound = () => reply(404, "Không tìm thấy file Word gốc.", "NOT_FOUND");

/** Tên có dấu đi qua `filename*` (RFC 5987); `filename` chỉ là bản ASCII cho trình duyệt cũ. */
export function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["%]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * `GET /api/v1/docs/word-imports/:importId/files/:fileId/original`: file Word gốc, chỉ người đọc được tài liệu tạo ra
 * từ nó tải được (FR-020). Lượt chưa tạo tài liệu thì chưa có gì để đọc, nên không ai tải được, kể cả người nhập.
 */
export async function handleWordOriginal(
  deps: WordHttpDeps,
  request: Request,
  params: WordOriginalParams,
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
    const found = await withTenant(deps.pool, ctx, async (tx) => {
      await requireOrgRole(tx, ctx.userId, "member");
      const [file] = await tx
        .select()
        .from(docWordImportFiles)
        .where(and(eq(docWordImportFiles.id, params.fileId), eq(docWordImportFiles.importId, params.importId)));
      if (!file?.blobId || !file.docId) return null;
      if (!(await canReadDoc(tx, { kind: "user", userId: ctx.userId }, file.docId))) return null;
      const chunks: Uint8Array[] = [];
      for await (const chunk of await blobStore.get(tx, orgId, file.blobId)) chunks.push(chunk);
      await recordAudit(tx, {
        action: "docs.word_original.download",
        targetType: "doc",
        targetId: file.docId,
        data: { importId: file.importId, fileId: file.id, fileName: file.fileName, sha256: file.sha256 },
      });
      return { file, body: Buffer.concat(chunks) };
    });
    if (!found) return notFound();
    return new Response(found.body, {
      status: 200,
      headers: {
        "Content-Type": MEDIA_TYPES[found.file.format] ?? "application/octet-stream",
        "Content-Disposition": attachmentDisposition(found.file.fileName),
        "Content-Length": String(found.body.byteLength),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof NotFoundError) return notFound();
    if (error instanceof ForbiddenError) return reply(403, error.message, "FORBIDDEN");
    throw error;
  }
}
