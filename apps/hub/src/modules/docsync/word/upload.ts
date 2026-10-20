import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WORD_IMPORT_ERRORS,
  type WordImportErrorCode,
  type WordImportUploadInput,
  wordImportFormatOf,
  wordImportUploadInput,
} from "@xdev-hive/contracts";
import { recordAudit } from "../../audit/index.ts";
import { authorize, docScope, getDoc, type Principal, readerFor } from "../../knowledge/index.ts";
import {
  BadRequestError,
  type BlobReader,
  type BlobStore,
  ConflictError,
  createPostgresBlobStore,
  ForbiddenError,
  inspectWordFile,
  loadDocStorageLimits,
  NotFoundError,
  type Tx,
  WORD_MEDIA_TYPES,
  type WordFormat,
  withTenant,
} from "../../platform/index.ts";
import { ORG_HEADER, requireOrgRole } from "../../tenancy/index.ts";
import { docLocation } from "../assets.ts";
import { type HomeRow, homeById } from "../homes.ts";
import { keyFromPath, matchesHome } from "../paths.ts";
import { queueWordImport } from "../queues.ts";
import { pathHomeOf } from "../scan.ts";
import { docWordImportFiles, docWordImports, type WordImportCountsRow } from "../schema.ts";
import { MultipartError, type MultipartFile, multipartBoundary, parseMultipart } from "./multipart.ts";
import { planNames, stripVersion } from "./names.ts";
import { type WordHttpDeps, type WordTools, wordImportHealth, wordTools } from "./tools.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Ranh giới, tên trường và các trường chữ không tính vào dung lượng file. Mỗi file kèm tên, thư mục con và ngày sửa
// nên phần chừa tăng theo số file.
const MULTIPART_OVERHEAD = 64 * 1024;
const PART_OVERHEAD = 4 * 1024;
const NO_FILES: WordImportCountsRow = {
  queued: 0,
  converting: 0,
  ready: 0,
  skipped: 0,
  blockedSecret: 0,
  failed: 0,
  proposed: 0,
  cancelled: 0,
  done: 0,
};

/** Lỗi theo bảng `WORD_IMPORT_ERRORS` của contracts, cùng dạng oRPC (`data.code`) để web và desktop dùng chung chữ. */
class WordImportError extends Error {
  readonly code: WordImportErrorCode;
  readonly data: { path?: string; limit?: number };
  constructor(
    code: WordImportErrorCode,
    data: { path?: string; limit?: number } = {},
    message: string = WORD_IMPORT_ERRORS[code].message,
  ) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

type HttpError = ForbiddenError | NotFoundError | ConflictError | BadRequestError;
const STATUS = { BAD_REQUEST: 400, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409 } as const;

const reply = (status: number, message: string, code?: string) =>
  Response.json({ defined: false, code: code ?? "BAD_REQUEST", status, message }, { status });

function errorResponse(error: unknown): Response {
  if (error instanceof WordImportError) {
    const code = WORD_IMPORT_ERRORS[error.code].status;
    const status = STATUS[code];
    return Response.json(
      { defined: false, code, status, message: error.message, data: { ...error.data, code: error.code } },
      { status },
    );
  }
  const known: Array<[new (...args: never[]) => HttpError, keyof typeof STATUS]> = [
    [BadRequestError, "BAD_REQUEST"],
    [ForbiddenError, "FORBIDDEN"],
    [NotFoundError, "NOT_FOUND"],
    [ConflictError, "CONFLICT"],
  ];
  for (const [type, code] of known) {
    if (error instanceof type) {
      const extra = error instanceof ConflictError ? error.data : undefined;
      const status = STATUS[code];
      return Response.json(
        { defined: false, code, status, message: error.message, data: { ...extra, code: error.code } },
        { status },
      );
    }
  }
  throw error;
}

async function session(deps: WordHttpDeps, request: Request) {
  // `deps.auth` đã bọc `withPersonalTokens` ở app.ts: token cá nhân của tổ chức khác với header thì ra null ở đây.
  const found = deps.auth ? await deps.auth.api.getSession({ headers: request.headers }) : null;
  if (!found) return { error: reply(401, "Chưa đăng nhập.", "UNAUTHORIZED") } as const;
  if (!deps.pool || !deps.jobs)
    return { error: reply(500, "Hub chưa cấu hình database hoặc hàng đợi.", "INTERNAL_SERVER_ERROR") } as const;
  const orgId = request.headers.get(ORG_HEADER);
  if (!orgId || !UUID.test(orgId)) return { error: reply(400, `Chưa chọn tổ chức (header ${ORG_HEADER}).`) } as const;
  return { pool: deps.pool, jobs: deps.jobs, ctx: { userId: found.user.id, orgId } } as const;
}

function fileReader(path: string, size: number): BlobReader & { close(): Promise<void> } {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  return {
    size,
    async read(offset, length) {
      if (offset < 0 || length < 0 || offset + length > size) throw new Error("Vùng đọc file không hợp lệ.");
      handle ??= await open(path, "r");
      const bytes = Buffer.alloc(length);
      const { bytesRead } = await handle.read(bytes, 0, length, offset);
      return bytes.subarray(0, bytesRead);
    },
    async close() {
      await handle?.close();
    },
  };
}

/** Nhận dạng theo nội dung, không theo đuôi hay `Content-Type` client gửi (FR-002, Edge Cases). */
async function formatOf(file: MultipartFile): Promise<WordFormat> {
  const reader = fileReader(file.path, file.size);
  try {
    return await inspectWordFile(reader, file.name);
  } catch (error) {
    if (error instanceof BadRequestError && error.code === "BLOB_ENCRYPTED")
      throw fileError("WORD_IMPORT_PASSWORD", file);
    if (error instanceof BadRequestError && error.code === "BLOB_TYPE_MISMATCH")
      throw fileError("WORD_IMPORT_NOT_WORD", file);
    throw error;
  } finally {
    await reader.close();
  }
}

const fileError = (code: WordImportErrorCode, file: { name: string }, data: { limit?: number } = {}) =>
  new WordImportError(code, data, `${file.name}: ${WORD_IMPORT_ERRORS[code].message}`);

interface Upload {
  file: MultipartFile;
  format: WordFormat;
  relativeDir: string;
  lastModified: number | undefined;
}

/** File bị loại theo nội dung (mật khẩu, không phải Word, `.doc` khi tắt): vẫn ghi vào lượt để báo cáo nêu lý do. */
interface Rejected {
  file: MultipartFile;
  relativeDir: string;
  lastModified: number | undefined;
  error: WordImportError;
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

interface PlannedRow {
  upload: Upload;
  state: "queued" | "skipped";
  proposedPath: string | null;
  proposedTitle: string | null;
  versionLabel: string | null;
  warnings: Array<{ code: string; count: number; detail: string | null }>;
}

const join2 = (...parts: string[]) => parts.filter(Boolean).join("/");

/** `targetDir` nằm trong gốc của nhà (`docs/` mặc định); gốc rỗng thì cả repo. */
function insideRoot(home: HomeRow, dir: string): boolean {
  const root = home.root.replace(/\/+$/, "");
  return !root || dir === root || dir.startsWith(`${root}/`);
}

/**
 * Tạo mới: đường dẫn đề xuất theo FR-006, mỗi file phải ra key tài liệu trong nhà, và người nhập cần `propose` ở phạm
 * vi của từng thư mục. Quyền `manage` được kiểm lại lúc tạo tài liệu.
 */
async function planCreate(tx: Tx, principal: Principal, home: HomeRow, targetDir: string, uploads: Upload[]) {
  if (!insideRoot(home, targetDir)) throw new WordImportError("WORD_IMPORT_OUTSIDE_HOME", pathData(targetDir));
  const { pathHome, managed } = await pathHomeOf(tx, home, home);
  const plan = planNames(
    uploads.map((upload) => ({
      upload,
      path: join2(upload.relativeDir, upload.file.name),
      ...(upload.lastModified === undefined ? {} : { lastModified: upload.lastModified }),
    })),
    targetDir,
  );
  const keyOf = (path: string) => {
    try {
      return matchesHome(path, pathHome, { sdlcPaths: managed, skillRoots: managed })
        ? keyFromPath(path, pathHome)
        : null;
    } catch {
      return null;
    }
  };
  const reader = await readerFor(tx, principal);
  const checked = new Set<string>();
  const rows: PlannedRow[] = [];
  for (const planned of plan.planned) {
    if (!keyOf(planned.path)) throw new WordImportError("WORD_IMPORT_OUTSIDE_HOME", pathData(planned.path));
    // Phạm vi (tổ chức, đội, dự án) suy từ thư mục như plan.md mục 2: key thử `<thư mục>/x.md`, mỗi thư mục một lần.
    const dir = planned.path.slice(0, Math.max(0, planned.path.lastIndexOf("/")));
    if (!checked.has(dir)) {
      checked.add(dir);
      const probe = keyOf(join2(dir, "x.md"));
      if (!probe) throw new WordImportError("WORD_IMPORT_OUTSIDE_HOME", pathData(planned.path));
      await authorize(tx, reader, await docScope(tx, reader, probe), "propose");
    }
    rows.push({
      upload: planned.file.upload,
      state: "queued",
      proposedPath: planned.path,
      proposedTitle: null,
      versionLabel: planned.version,
      warnings: [],
    });
  }
  for (const dropped of plan.dropped) {
    rows.push({
      upload: dropped.file.upload,
      state: "skipped",
      proposedPath: null,
      proposedTitle: null,
      versionLabel: stripVersion(dropped.file.upload.file.name).version,
      warnings: [{ code: "skipped_older", count: 1, detail: dropped.winner.upload.file.name }],
    });
  }
  return rows;
}

/** Cập nhật (US3) hoặc gắn (US6): đúng một file, đường dẫn và tên theo tài liệu đích. */
async function planExisting(tx: Tx, principal: Principal, home: HomeRow, key: string, upload: Upload) {
  const doc = await getDoc(tx, principal, { key });
  const location = await docLocation(tx, doc);
  if (!location || location.home.id !== home.id)
    throw new WordImportError("WORD_IMPORT_OUTSIDE_HOME", location ? pathData(location.path) : {});
  const reader = await readerFor(tx, principal);
  await authorize(tx, reader, await docScope(tx, reader, doc.key), "propose");
  const row: PlannedRow = {
    upload,
    state: "queued",
    proposedPath: location.path,
    proposedTitle: doc.title,
    versionLabel: stripVersion(upload.file.name).version,
    warnings: [],
  };
  return { docId: doc.id, rows: [row] };
}

// `path` trong data lỗi là đường dẫn repo; đường dẫn rỗng (gốc repo) thì bỏ.
const pathData = (path: string) => (path ? { path } : {});

async function storeBlob(
  tx: Tx,
  blobStore: BlobStore,
  orgId: string,
  upload: Upload,
  tools: WordTools,
): Promise<{ id: string; size: number; sha256: string }> {
  try {
    return await blobStore.put(tx, orgId, createReadStream(upload.file.path), WORD_MEDIA_TYPES[upload.format], {
      filename: upload.file.name,
      maxBytes: tools.config.maxBytes,
    });
  } catch (error) {
    if (error instanceof BadRequestError && error.code === "BLOB_TOO_LARGE")
      throw fileError("WORD_IMPORT_FILE_TOO_LARGE", upload.file, { limit: tools.config.maxBytes });
    if (error instanceof BadRequestError && error.code === "BLOB_STORAGE_QUOTA")
      throw new ConflictError("DOCSYNC_ORG_STORAGE_FULL", "Tổ chức đã dùng hết dung lượng kho file.", {
        limit: loadDocStorageLimits().orgStorageBytes,
      });
    throw error;
  }
}

function formInput(form: { fields: Map<string, string[]>; files: MultipartFile[] }) {
  // Trường để trống coi như không gửi, trừ `targetDir`: rỗng là gốc repo.
  const one = (name: string) => {
    const value = form.fields.get(name)?.at(-1);
    return value === "" && name !== "targetDir" ? undefined : value;
  };
  return wordImportUploadInput.safeParse({
    homeId: one("homeId"),
    targetDir: one("targetDir"),
    mode: one("mode"),
    docKey: one("docKey"),
    confidential: one("confidential"),
    // File nằm trên đĩa; schema chỉ kiểm tên nên đưa vào `File` rỗng cùng tên, không nạp nội dung vào bộ nhớ.
    files: form.files.map((file) => new File([], file.name)),
    relativePaths: form.fields.get("relativePaths") ?? [],
    lastModified: form.fields.get("lastModified") ?? [],
  });
}

/** `POST /api/v1/docs/word-imports` (multipart, plan.md mục 2): phiên web hoặc token cá nhân, tổ chức từ `x-hive-org`. */
export async function handleWordUpload(deps: WordHttpDeps, request: Request): Promise<Response> {
  const auth = await session(deps, request);
  if ("error" in auth) return auth.error;
  const tools = wordTools();
  if (!tools?.pandoc.ok) return errorResponse(new WordImportError("WORD_IMPORT_DISABLED"));
  const { config } = tools;
  const bodyBytes = config.batchBytes + MULTIPART_OVERHEAD + config.batchFiles * PART_OVERHEAD;
  const batchTooLarge = () => new WordImportError("WORD_IMPORT_BATCH_TOO_LARGE", { limit: config.batchBytes });
  if (Number(request.headers.get("content-length") ?? 0) > bodyBytes) return errorResponse(batchTooLarge());
  const boundary = multipartBoundary(request.headers.get("content-type"));
  if (!boundary || !request.body) return reply(400, "Thân request phải là multipart/form-data có homeId và files.");

  const dir = await mkdtemp(join(tmpdir(), "hive-word-upload-"));
  try {
    let form: Awaited<ReturnType<typeof parseMultipart>>;
    try {
      form = await parseMultipart(
        request.body,
        boundary,
        { fileBytes: config.maxBytes, files: config.batchFiles, totalBytes: config.batchBytes, bodyBytes },
        dir,
      );
    } catch (error) {
      if (!(error instanceof MultipartError)) throw error;
      if (error.reason === "file_too_large")
        return errorResponse(
          new WordImportError("WORD_IMPORT_FILE_TOO_LARGE", { limit: config.maxBytes }, error.message),
        );
      if (error.reason === "batch_too_large") return errorResponse(batchTooLarge());
      return reply(400, error.message);
    }
    const parsed = formInput(form);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return reply(
        400,
        issue ? `${issue.path.join(".") || "form"}: ${issue.message}` : "Dữ liệu nhập Word không hợp lệ.",
      );
    }
    const input: WordImportUploadInput = parsed.data;
    const docEnabled = wordImportHealth().wordImportDoc;
    const uploads: Upload[] = [];
    const rejected: Rejected[] = [];
    const seen = new Set<string>();
    for (const [i, file] of form.files.entries()) {
      const relativeDir = input.relativePaths[i] ?? "";
      const lastModified = input.lastModified[i];
      // Bảng file của lượt khoá theo (thư mục con, tên): hai file trùng thì báo người dùng thay vì lỗi ràng buộc.
      const id = `${relativeDir}/${file.name}`;
      if (seen.has(id))
        throw new WordImportError("WORD_IMPORT_DUPLICATE_PATH", pathData(join2(relativeDir, file.name)));
      seen.add(id);
      try {
        const format = await formatOf(file);
        if (format === "doc" && !docEnabled) throw fileError("WORD_IMPORT_DOC_DISABLED", file);
        uploads.push({ file, format, relativeDir, lastModified });
      } catch (error) {
        if (!(error instanceof WordImportError)) throw error;
        rejected.push({ file, relativeDir, lastModified, error });
      }
    }
    // Một thư mục 30 file có vài file hỏng vẫn nhập phần còn lại, báo cáo nêu lý do từng file (US2). Không còn file
    // nào dùng được, hoặc cập nhật/gắn đúng một file, thì từ chối ngay để người dùng sửa file rồi gửi lại.
    const [firstRejected] = rejected;
    if (firstRejected && (uploads.length === 0 || input.mode !== "create")) throw firstRejected.error;

    const principal: Principal = { kind: "user", userId: auth.ctx.userId };
    const blobStore = deps.blobStore ?? createPostgresBlobStore({ limits: loadDocStorageLimits(), jobs: auth.jobs });
    const importId = await withTenant(auth.pool, auth.ctx, async (tx) => {
      await requireOrgRole(tx, auth.ctx.userId, "member");
      const home = await homeById(tx, input.homeId);
      let updateDocId: string | null = null;
      let rows: PlannedRow[];
      if (input.mode === "create") {
        rows = await planCreate(tx, principal, home, input.targetDir ?? "", uploads);
      } else {
        const [upload] = uploads;
        if (!upload || !input.docKey)
          throw new BadRequestError("BAD_REQUEST", "Cập nhật hoặc gắn chỉ nhận đúng một file.");
        const existing = await planExisting(tx, principal, home, input.docKey, upload);
        updateDocId = existing.docId;
        rows = existing.rows;
      }

      const blobs: Array<{ id: string; size: number; sha256: string }> = [];
      for (const row of rows) blobs.push(await storeBlob(tx, blobStore, auth.ctx.orgId, row.upload, tools));
      const counts = {
        ...NO_FILES,
        queued: rows.filter((row) => row.state === "queued").length,
        skipped: rows.filter((row) => row.state === "skipped").length,
        failed: rejected.length,
      };
      const [created] = await tx
        .insert(docWordImports)
        .values({
          orgId: auth.ctx.orgId,
          homeId: home.id,
          targetDir: input.mode === "create" ? (input.targetDir ?? "") : null,
          mode: input.mode,
          updateDocId,
          confidential: input.confidential ?? home.wordImportConfidential,
          state: "converting",
          counts,
          createdBy: auth.ctx.userId,
        })
        .returning({ id: docWordImports.id });
      if (!created) throw new Error("Không ghi được lượt nhập Word.");
      const failed = [];
      for (const { file, relativeDir, lastModified, error } of rejected) {
        failed.push({
          orgId: auth.ctx.orgId,
          importId: created.id,
          relativeDir,
          fileName: file.name,
          // Tên đã qua schema của contracts nên luôn có đuôi Word; đuôi là thứ người dùng thấy, nội dung thì không khớp.
          format: wordImportFormatOf(file.name) ?? "docx",
          size: file.size,
          sha256: await sha256Of(file.path),
          blobId: null,
          lastModified: lastModified === undefined ? null : new Date(lastModified),
          versionLabel: stripVersion(file.name).version,
          // Câu của contracts (FR-022), không kèm tên file như lỗi trả ngay: báo cáo đã có cột tên file.
          error: { code: error.code, message: WORD_IMPORT_ERRORS[error.code].message },
          state: "failed",
        });
      }
      const files = await tx
        .insert(docWordImportFiles)
        .values([
          ...rows.map((row, i) => {
            const blob = blobs[i] as (typeof blobs)[number];
            return {
              orgId: auth.ctx.orgId,
              importId: created.id,
              relativeDir: row.upload.relativeDir,
              fileName: row.upload.file.name,
              format: row.upload.format,
              size: blob.size,
              sha256: blob.sha256,
              blobId: blob.id,
              lastModified: row.upload.lastModified === undefined ? null : new Date(row.upload.lastModified),
              versionLabel: row.versionLabel,
              proposedPath: row.proposedPath,
              proposedTitle: row.proposedTitle,
              warnings: row.warnings,
              state: row.state,
            };
          }),
          ...failed,
        ])
        .returning({ id: docWordImportFiles.id, state: docWordImportFiles.state });
      for (const file of files) {
        if (file.state === "queued")
          await queueWordImport(auth.jobs, { orgId: auth.ctx.orgId, fileId: file.id }, { tx });
      }
      await recordAudit(tx, {
        action: "doc.word_import.upload",
        targetType: "doc_word_import",
        targetId: created.id,
        data: {
          homeId: home.id,
          mode: input.mode,
          files: rows.length + rejected.length,
          skipped: counts.skipped,
          failed: counts.failed,
          docKey: input.docKey,
        },
      });
      return created.id;
    });
    return Response.json({ importId }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
