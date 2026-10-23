import { artifactScope, projectKey as projectKeySchema } from "@xdev-hive/contracts";
import type pg from "pg";
import type { Auth } from "../identity/index.ts";
import {
  BadRequestError,
  type BlobStore,
  ConflictError,
  createPostgresBlobStore,
  ForbiddenError,
  type Jobs,
  NotFoundError,
  type Tx,
  withTenant,
} from "../platform/index.ts";
import { ORG_HEADER, requireOrgRole } from "../tenancy/index.ts";
import { artifactError, readerFor } from "./access.ts";
import { type BlobArtifactType, blobTypeOf } from "./blob-types.ts";
import { artifactPolicyOf, formatBytes, operatorCeilings } from "./limits.ts";
import { createArtifact, replaceBlob } from "./service.ts";
import { assertWritable } from "./versions.ts";

export const ARTIFACT_UPLOAD_PATH = "/api/v1/artifacts/upload";

export interface ArtifactUploadDeps {
  pool?: pg.Pool | undefined;
  auth?: Auth | undefined;
  jobs?: Jobs | undefined;
  publicUrl?: string | undefined;
  blobStore?: BlobStore | undefined;
  /** Test thay trần của người vận hành để khỏi gửi hàng chục MB. */
  maxBlobBytes?: number | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Phần đầu multipart (ranh giới, tên trường) không tính vào tệp; chừa rộng để không chặn nhầm tệp vừa ngưỡng.
const MULTIPART_OVERHEAD = 64 * 1024;
const BY_EXTENSION: Record<string, BlobArtifactType> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  pdf: "pdf",
};
const REJECTED = "Chỉ nhận ảnh PNG, JPEG, GIF, WebP và tệp PDF.";

type HttpError = ForbiddenError | NotFoundError | ConflictError | BadRequestError;
const STATUS: Array<[new (...args: never[]) => HttpError, number, string]> = [
  [BadRequestError, 400, "BAD_REQUEST"],
  [ForbiddenError, 403, "FORBIDDEN"],
  [NotFoundError, 404, "NOT_FOUND"],
  [ConflictError, 409, "CONFLICT"],
];

/** Cùng dạng lỗi với oRPC (`data.code`) để web đọc lỗi tải tệp như mọi lỗi khác của hub. */
function errorResponse(error: unknown): Response {
  for (const [type, status, code] of STATUS) {
    if (error instanceof type) {
      const detail = (error as { detail?: object }).detail;
      const extra = error instanceof ConflictError ? error.data : undefined;
      return Response.json(
        { defined: false, code, status, message: error.message, data: { ...extra, ...detail, code: error.code } },
        { status },
      );
    }
  }
  throw error;
}

const reply = (status: number, message: string, code = "BAD_REQUEST") =>
  Response.json({ defined: false, code, status, message }, { status });

/** Loại artifact theo MIME khai báo hoặc đuôi tệp; magic bytes kiểm sau, khi `BlobStore` đã đọc nội dung. */
function declaredType(file: File): BlobArtifactType | null {
  const mime = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime && mime !== "application/octet-stream") return blobTypeOf(mime);
  return BY_EXTENSION[file.name.split(".").at(-1)?.toLowerCase() ?? ""] ?? null;
}

const titleOf = (file: File) => file.name.replace(/\.[^.]+$/, "").trim() || "Tệp tải lên";

const field = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

async function storeBlob(tx: Tx, deps: ArtifactUploadDeps, orgId: string, file: File, maxBytes: number) {
  const store = deps.blobStore ?? createPostgresBlobStore(deps.jobs ? { jobs: deps.jobs } : {});
  try {
    return await store.put(
      tx,
      orgId,
      file.stream() as AsyncIterable<Uint8Array>,
      file.type || "application/octet-stream",
      { filename: file.name, maxBytes },
    );
  } catch (error) {
    if (error instanceof BadRequestError && error.code === "BLOB_TOO_LARGE")
      throw artifactError("ARTIFACT_TOO_LARGE", `Tệp quá lớn (giới hạn ${formatBytes(maxBytes)}).`, {
        limit: maxBytes,
      });
    if (error instanceof BadRequestError && error.code === "BLOB_STORAGE_QUOTA")
      throw artifactError("ARTIFACT_QUOTA_EXCEEDED", "Kho file của tổ chức đã hết dung lượng cho phép.");
    throw error;
  }
}

/**
 * POST /api/v1/artifacts/upload (multipart: `file`, và `title`, `scope`, `projectKey`, `teamId`, hoặc `id` +
 * `baseVersion` để thay tệp của artifact có sẵn). Đi qua Hono như đính kèm tài liệu vì oRPC không hợp với thân lớn.
 */
export async function handleArtifactUpload(deps: ArtifactUploadDeps, request: Request): Promise<Response> {
  const found = deps.auth ? await deps.auth.api.getSession({ headers: request.headers }) : null;
  if (!found) return reply(401, "Chưa đăng nhập.", "UNAUTHORIZED");
  if (!deps.pool) return reply(500, "Hub chưa cấu hình HIVE_DATABASE_URL.", "INTERNAL_SERVER_ERROR");
  const orgId = request.headers.get(ORG_HEADER) ?? new URL(request.url).searchParams.get("org");
  if (!orgId || !UUID.test(orgId)) return reply(400, `Chưa chọn tổ chức (header ${ORG_HEADER}).`);

  const ceiling = deps.maxBlobBytes ?? operatorCeilings().maxBlobBytes;
  if (Number(request.headers.get("content-length") ?? 0) > ceiling + MULTIPART_OVERHEAD)
    return errorResponse(artifactError("ARTIFACT_TOO_LARGE", undefined, { limit: ceiling }));
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return reply(400, "Thân request phải là multipart/form-data có trường file.");
  }
  const file = form.get("file");
  if (!(file instanceof File)) return reply(400, "Thiếu tệp cần tải lên.");
  const type = declaredType(file);
  if (!type) return reply(400, REJECTED, "ARTIFACT_BLOB_TYPE");
  const scope = artifactScope.safeParse(field(form, "scope") ?? "private");
  const project = field(form, "projectKey");
  if (!scope.success || (project && !projectKeySchema.safeParse(project).success))
    return reply(400, "Phạm vi hoặc khoá dự án không hợp lệ.");
  const replaceId = field(form, "id");
  if (replaceId && !UUID.test(replaceId)) return reply(400, "Mã artifact không hợp lệ.");
  const baseVersion = Number(field(form, "baseVersion"));
  const title = field(form, "title");
  const teamId = field(form, "teamId");
  const message = field(form, "message");

  try {
    const result = await withTenant(deps.pool, { userId: found.user.id, orgId }, async (tx) => {
      await requireOrgRole(tx, found.user.id, "member");
      const reader = await readerFor(tx, { kind: "user", userId: found.user.id });
      const policy = await artifactPolicyOf(tx);
      assertWritable(policy, type);
      const blob = await storeBlob(tx, deps, orgId, file, Math.min(policy.maxBlobBytes, ceiling));
      // `inspectFileType` đã đối chiếu đuôi, MIME khai báo và magic bytes; ở đây chỉ chặn loại ngoài ảnh/PDF.
      if (blobTypeOf(blob.mediaType) !== type) throw new BadRequestError("ARTIFACT_BLOB_TYPE", REJECTED);
      const ref = { id: blob.id, sha256: blob.sha256, size: blob.size };
      const write = { jobs: deps.jobs, publicUrl: deps.publicUrl };
      if (replaceId)
        return replaceBlob(
          tx,
          reader,
          {
            id: replaceId,
            type,
            blob: ref,
            ...(Number.isInteger(baseVersion) && baseVersion > 0 ? { baseVersion } : {}),
            ...(title ? { title } : {}),
            ...(message ? { message } : {}),
          },
          write,
        );
      return createArtifact(
        tx,
        reader,
        {
          type,
          title: title ?? titleOf(file),
          content: "",
          scope: scope.data,
          ...(project ? { projectKey: project } : {}),
          ...(teamId ? { teamId } : {}),
          ...(message ? { message } : {}),
        },
        { ...write, blob: ref },
      );
    });
    return Response.json(result, { status: replaceId ? 200 : 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
