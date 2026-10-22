import {
  WORD_IMPORT_ERRORS,
  type WordImport,
  type WordImportFile,
  type WordImportFileDetail,
  type WordImportGetOutput,
  type WordImportState,
  type WordImportUpdateInput,
  wordImportMediaPath,
} from "@xdev-hive/contracts";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { docScope, getDoc, type Principal, type Reader, readerFor } from "../../knowledge/index.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  type Jobs,
  NotFoundError,
  type Tx,
} from "../../platform/index.ts";
import { queueWordDoc, queueWordImport } from "../queues.ts";
import { docWordImportFiles, docWordImports } from "../schema.ts";
import { frontMatter } from "../word/postprocess.ts";
import {
  canManage,
  docKeyOf,
  type FilePlace,
  filePlaces,
  keyOfPath,
  loadWordTarget,
  NO_PLACE,
  pathOf,
  refreshWordImportCounts,
  scopeKeyOf,
  taken,
  type WordTarget,
  wordFileView,
  wordImportOf,
} from "../word/shared.ts";
import type { WordImportFileRow, WordImportRow } from "../word/tools.ts";
import { type DocSyncRouteDeps, docSyncApi } from "./common.ts";

const notFound = () => new NotFoundError("WORD_IMPORT_NOT_FOUND", "Không tìm thấy lượt nhập Word.");
const fileNotFound = () => new NotFoundError("WORD_IMPORT_FILE_NOT_FOUND", "Không tìm thấy file trong lượt nhập Word.");
const LIST_BATCH = 200;
const OPEN_IMPORT = ["converting", "ready"];
const CLOSED_FILE = ["done", "proposed", "cancelled", "skipped"];
// File không bao giờ thành tài liệu thì không giữ đường dẫn của file khác.
const NOT_CREATED = ["cancelled", "skipped", "failed"];
const FRONT_MATTER = /^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
// Link ảnh của tài liệu có sẵn về tên ảnh, như Markdown vừa chuyển, để so từng khối không lệch vì đường dẫn.
const STORED_IMAGE_LINK = /(!?\[[^\]]*\]\()(?:[^()\s]*\/)?([0-9a-f]{12}\.[a-z0-9]+)(\))/g;

/** Phạm vi không thấy được thì coi như không có quyền, để người gọi nhận 404 thay vì lỗi. */
async function canManageVisible(tx: Tx, reader: Reader, key: string): Promise<boolean> {
  try {
    return await canManage(tx, reader, key);
  } catch (error) {
    if (error instanceof NotFoundError) return false;
    throw error;
  }
}

/**
 * Chỉ người tạo lượt và người `manage` ở phạm vi đích thấy lượt nhập (plan.md mục 5): Markdown chưa qua duyệt có thể
 * chứa nội dung chưa nên lộ. Người khác nhận 404 như lượt không tồn tại.
 */
export async function wordImportAccess(
  tx: Tx,
  principal: Principal,
  target: WordTarget,
): Promise<WordImportGetOutput["access"] | null> {
  const key = await scopeKeyOf(tx, target);
  if (key && (await canManageVisible(tx, await readerFor(tx, principal), key))) return "manage";
  return principal.kind === "user" && target.imp.createdBy === principal.userId ? "propose" : null;
}

/** Tài liệu đọc được theo cách `getDoc` đọc: không có hoặc không đọc được đều là false, không lộ là có tồn tại. */
export async function canReadDoc(tx: Tx, principal: Principal, docId: string | null): Promise<boolean> {
  const key = await docKeyOf(tx, docId);
  if (!key) return false;
  try {
    await docScope(tx, await readerFor(tx, principal), key);
    return true;
  } catch (error) {
    if (error instanceof NotFoundError) return false;
    throw error;
  }
}

/** Lượt có tài liệu đích hoặc tài liệu đã tạo mà người gọi đọc được (FR-020, US5). */
async function hasReadableDoc(tx: Tx, principal: Principal, imp: WordImportRow): Promise<boolean> {
  const rows = await tx
    .selectDistinct({ docId: docWordImportFiles.docId })
    .from(docWordImportFiles)
    .where(and(eq(docWordImportFiles.importId, imp.id), isNotNull(docWordImportFiles.docId)));
  const ids = new Set<string>(rows.flatMap((r) => (r.docId ? [r.docId] : [])));
  if (imp.updateDocId) ids.add(imp.updateDocId);
  for (const id of ids) if (await canReadDoc(tx, principal, id)) return true;
  return false;
}

export async function loadVisible(tx: Tx, principal: Principal, importId: string, lock = false) {
  const target = await loadWordTarget(tx, importId, lock);
  const access = await wordImportAccess(tx, principal, target);
  if (!access) throw notFound();
  return { target, access };
}

async function loadFile(tx: Tx, principal: Principal, fileId: string, lock = false) {
  const [found] = await tx
    .select({ importId: docWordImportFiles.importId })
    .from(docWordImportFiles)
    .where(eq(docWordImportFiles.id, fileId));
  if (!found) throw fileNotFound();
  // Khoá lượt trước file, cùng thứ tự với job chuyển và bước tạo.
  const visible = await loadVisible(tx, principal, found.importId, lock).catch((error) => {
    throw error instanceof NotFoundError ? fileNotFound() : error;
  });
  const query = tx.select().from(docWordImportFiles).where(eq(docWordImportFiles.id, fileId));
  const [file] = lock ? await query.for("update") : await query;
  if (!file) throw fileNotFound();
  return { ...visible, file };
}

// ---- Dạng trả về ---------------------------------------------------------------------------------------------------

async function placeOf(tx: Tx, target: WordTarget, file: WordImportFileRow): Promise<FilePlace> {
  return (await filePlaces(tx, target, [file])).get(file.id) ?? NO_PLACE;
}

// ---- Thao tác -----------------------------------------------------------------------------------------------------

export async function getWordImport(tx: Tx, principal: Principal, importId: string): Promise<WordImportGetOutput> {
  const { target, access } = await loadVisible(tx, principal, importId);
  const files = await tx
    .select()
    .from(docWordImportFiles)
    .where(eq(docWordImportFiles.importId, importId))
    .orderBy(asc(docWordImportFiles.relativeDir), asc(docWordImportFiles.fileName));
  const places = await filePlaces(tx, target, files);
  return {
    import: await wordImportOf(tx, target.imp),
    files: files.map((f) => wordFileView(f, places.get(f.id) ?? NO_PLACE)),
    access,
  };
}

const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|([0-9a-f-]{36})$/;
// Postgres giữ micro giây, Date chỉ có mili giây: so và xếp theo mili giây để con trỏ không bỏ sót hàng.
const createdMs = sql`date_trunc('milliseconds', ${docWordImports.createdAt})`;

/** Lượt nhập của một nhà mà người gọi thấy được, mới nhất trước. */
export async function listWordImports(
  tx: Tx,
  principal: Principal,
  input: { homeId: string; cursor?: string | undefined; limit: number; state?: WordImportState | undefined },
): Promise<{ items: WordImport[]; nextCursor: string | null }> {
  let after: { at: Date; id: string } | null = null;
  if (input.cursor !== undefined) {
    const match = CURSOR.exec(input.cursor);
    const at = match ? new Date(match[1] as string) : null;
    if (!match || !at || Number.isNaN(at.getTime()))
      throw new BadRequestError("WORD_IMPORT_INVALID_CURSOR", "Con trỏ danh sách lượt nhập Word không hợp lệ.");
    after = { at, id: match[2] as string };
  }
  const targets = new Map<string, WordTarget>();
  const access = new Map<string, boolean>();
  const visible: WordImportRow[] = [];
  // Quyền xét theo từng lượt nên lọc sau khi đọc; đọc theo lô tới khi đủ một trang.
  for (;;) {
    const rows = await tx
      .select()
      .from(docWordImports)
      .where(
        and(
          eq(docWordImports.homeId, input.homeId),
          input.state ? eq(docWordImports.state, input.state) : undefined,
          after
            ? sql`(${createdMs}, ${docWordImports.id}) < (${after.at.toISOString()}::timestamptz, ${after.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(createdMs), desc(docWordImports.id))
      .limit(LIST_BATCH);
    for (const imp of rows) {
      // Cùng thư mục đích, cùng tài liệu đích và cùng người tạo thì cùng kết quả quyền.
      const cacheKey = `${imp.mode}|${imp.targetDir}|${imp.updateDocId}|${imp.createdBy}`;
      let ok = access.get(cacheKey);
      if (ok === undefined) {
        let target = targets.get(imp.homeId);
        if (!target) {
          target = await loadWordTarget(tx, imp.id);
          targets.set(imp.homeId, target);
        }
        ok = (await wordImportAccess(tx, principal, { ...target, imp })) !== null;
        access.set(cacheKey, ok);
      }
      // Tài liệu tạo ra từ lượt thì ai đọc được tài liệu cũng thấy lượt đã sinh ra nó (US5); tài liệu khác nhau theo
      // từng lượt nên không dùng chung kết quả.
      if (!ok) ok = await hasReadableDoc(tx, principal, imp);
      if (ok) visible.push(imp);
      if (visible.length > input.limit) break;
    }
    const last = rows.at(-1);
    if (visible.length > input.limit || rows.length < LIST_BATCH || !last) break;
    after = { at: last.createdAt, id: last.id };
  }
  const page = visible.slice(0, input.limit);
  const names = new Map<string, string | null>();
  const items: WordImport[] = [];
  for (const imp of page) items.push(await wordImportOf(tx, imp, names));
  const tail = page.at(-1);
  return {
    items,
    nextCursor: visible.length > input.limit && tail ? `${tail.createdAt.toISOString()}|${tail.id}` : null,
  };
}

/** Lần nhập gần nhất tạo, cập nhật hoặc gắn tài liệu; null khi tài liệu chưa từng nhập từ Word hoặc không đọc được. */
export async function wordImportOfDoc(
  tx: Tx,
  principal: Principal,
  input: { docKey: string },
): Promise<{ import: WordImport; file: WordImportFile } | null> {
  const { rows } = await tx.execute<{ id: string }>(sql`select id from hive.docs where key = ${input.docKey}`);
  const docId = rows[0]?.id;
  if (!docId || !(await canReadDoc(tx, principal, docId))) return null;
  const [latest] = await tx
    .select({ file: docWordImportFiles })
    .from(docWordImportFiles)
    .innerJoin(docWordImports, eq(docWordImports.id, docWordImportFiles.importId))
    .where(and(eq(docWordImportFiles.docId, docId), inArray(docWordImportFiles.state, ["done", "skipped"])))
    .orderBy(desc(createdMs), desc(docWordImports.id), desc(docWordImportFiles.createdAt))
    .limit(1);
  if (!latest) return null;
  const target = await loadWordTarget(tx, latest.file.importId);
  const places = await filePlaces(tx, target, [latest.file]);
  return {
    import: await wordImportOf(tx, target.imp),
    file: wordFileView(latest.file, places.get(latest.file.id) ?? NO_PLACE),
  };
}

/** Markdown và ảnh của một file để xem trước; gắn và cập nhật kèm nội dung hiện tại của tài liệu đích. */
export async function getWordImportFile(tx: Tx, principal: Principal, fileId: string): Promise<WordImportFileDetail> {
  const { target, file } = await loadFile(tx, principal, fileId);
  const converted = file.state !== "queued" && file.state !== "converting" && file.state !== "failed";
  let current: WordImportFileDetail["current"] = null;
  const docKey = target.imp.mode === "create" ? null : await docKeyOf(tx, target.imp.updateDocId);
  if (docKey) {
    try {
      const doc = await getDoc(tx, principal, { key: docKey });
      current = {
        content: doc.content
          .replace(FRONT_MATTER, "")
          .replace(/^(?:[ \t]*\r?\n)+/, "")
          .replace(STORED_IMAGE_LINK, "$1$2$3"),
        version: doc.version,
      };
    } catch (error) {
      if (!(error instanceof NotFoundError || error instanceof ForbiddenError)) throw error;
    }
  }
  return {
    ...wordFileView(file, await placeOf(tx, target, file)),
    markdown: converted ? file.markdown : null,
    images: converted
      ? file.images.map((image) => ({
          name: image.name,
          mediaType: image.mediaType,
          bytes: image.bytes,
          url: wordImportMediaPath(file.importId, file.id, image.name),
        }))
      : [],
    current,
  };
}

/** Key và đường dẫn của các file khác trong lượt còn có thể thành tài liệu. */
async function siblingKeys(tx: Tx, target: WordTarget, fileId: string): Promise<Set<string>> {
  const files = await tx
    .select()
    .from(docWordImportFiles)
    .where(
      and(
        eq(docWordImportFiles.importId, target.imp.id),
        eq(docWordImportFiles.excluded, false),
        sql`${docWordImportFiles.state} not in (${sql.join(
          NOT_CREATED.map((s) => sql`${s}`),
          sql`, `,
        )})`,
        sql`${docWordImportFiles.id} <> ${fileId}`,
      ),
    );
  const keys = new Set<string>();
  for (const f of files) {
    const key = keyOfPath(target, pathOf(f));
    if (key) keys.add(key);
  }
  return keys;
}

const errorOf = (code: keyof typeof WORD_IMPORT_ERRORS) => WORD_IMPORT_ERRORS[code].message;

/** Sửa đường dẫn, tiêu đề, bỏ chọn, hoặc đổi `keepFront` (chạy lại pandoc cho file đó, Q5). */
export async function updateWordImportFile(
  tx: Tx,
  jobs: Jobs | undefined,
  principal: Principal,
  input: WordImportUpdateInput,
): Promise<WordImportFile> {
  const { target, file } = await loadFile(tx, principal, input.fileId, true);
  if (!OPEN_IMPORT.includes(target.imp.state))
    throw new ConflictError("WORD_IMPORT_CLOSED", "Lượt nhập đã xong hoặc đã huỷ, không sửa được nữa.");
  if (CLOSED_FILE.includes(file.state))
    throw new ConflictError(
      "WORD_IMPORT_FILE_CLOSED",
      "File này đã tạo, đã gửi duyệt hoặc đã bỏ qua, không sửa được nữa.",
    );
  const patch: Partial<WordImportFileRow> = {};
  const excluded = input.excluded ?? file.excluded;
  if (input.excluded !== undefined) patch.excluded = input.excluded;
  if (input.path !== undefined && input.path !== pathOf(file)) {
    if (target.imp.mode !== "create")
      throw new BadRequestError("WORD_IMPORT_PATH_FIXED", "Cập nhật hoặc gắn giữ đường dẫn của tài liệu đích.");
    const key = keyOfPath(target, input.path);
    if (!key) throw new BadRequestError("WORD_IMPORT_OUTSIDE_HOME", errorOf("WORD_IMPORT_OUTSIDE_HOME"));
    if (!excluded && (await siblingKeys(tx, target, file.id)).has(key))
      throw new ConflictError("WORD_IMPORT_DUPLICATE_PATH", errorOf("WORD_IMPORT_DUPLICATE_PATH"), {
        path: input.path,
      });
    if (await taken(tx, target.home, key, input.path))
      throw new ConflictError("WORD_IMPORT_EXISTS", errorOf("WORD_IMPORT_EXISTS"), { path: input.path });
    patch.pathOverride = input.path === file.proposedPath ? null : input.path;
  }
  if (input.title !== undefined) {
    patch.titleOverride = input.title === file.proposedTitle ? null : input.title;
    // Front matter của bản xem trước đi theo tiêu đề mới; bước tạo cũng dựng lại từ tiêu đề cuối.
    if (file.markdown !== null)
      patch.markdown =
        frontMatter({
          title: input.title,
          file: file.fileName,
          sha256: file.sha256,
          confidential: target.imp.confidential,
        }) + file.markdown.replace(FRONT_MATTER, "").replace(/^(?:[ \t]*\r?\n)+/, "");
  }
  const rerun = input.keepFront !== undefined && input.keepFront !== file.keepFront;
  if (rerun) {
    if (!file.blobId || !jobs)
      throw new ConflictError("WORD_IMPORT_CONVERT_FAILED", errorOf("WORD_IMPORT_CONVERT_FAILED"));
    Object.assign(patch, {
      keepFront: input.keepFront as boolean,
      state: "queued",
      markdown: null,
      images: [],
      stats: null,
      warnings: [],
      findings: [],
      error: null,
      linkMatches: null,
    } satisfies Partial<WordImportFileRow>);
  }
  const [saved] = await tx
    .update(docWordImportFiles)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(docWordImportFiles.id, file.id))
    .returning();
  if (!saved) throw fileNotFound();
  if (rerun && jobs) {
    const job = { orgId: saved.orgId, fileId: saved.id };
    if (saved.format === "doc") await queueWordDoc(jobs, job, { tx });
    else await queueWordImport(jobs, job, { tx });
  }
  await refreshWordImportCounts(tx, target.imp.id, "convert");
  return wordFileView(saved, await placeOf(tx, target, saved));
}

/** Huỷ lượt: file chưa tạo thành `cancelled`, tài liệu đã tạo giữ nguyên. */
export async function cancelWordImport(tx: Tx, principal: Principal, importId: string): Promise<WordImport> {
  const { target } = await loadVisible(tx, principal, importId, true);
  const { imp } = target;
  if (imp.state === "done" || imp.state === "committing")
    throw new ConflictError("WORD_IMPORT_CLOSED", "Lượt nhập đã tạo tài liệu hoặc đang tạo, không huỷ được.");
  if (imp.state !== "cancelled") {
    await tx
      .update(docWordImportFiles)
      .set({ state: "cancelled", updatedAt: new Date() })
      .where(
        and(
          eq(docWordImportFiles.importId, imp.id),
          inArray(docWordImportFiles.state, ["queued", "converting", "ready", "blocked_secret"]),
        ),
      );
    await tx
      .update(docWordImports)
      .set({ state: "cancelled", updatedAt: new Date() })
      .where(eq(docWordImports.id, imp.id));
    await refreshWordImportCounts(tx, imp.id, "convert");
  }
  const [saved] = await tx.select().from(docWordImports).where(eq(docWordImports.id, imp.id));
  if (!saved) throw notFound();
  return wordImportOf(tx, saved);
}

/** Xem và chỉnh lượt nhập Word (plan.md mục 5), lịch sử nhập của tài liệu (US5). */
export function wordImportsRoutes(deps: DocSyncRouteDeps) {
  const api = docSyncApi(deps).wordImports;
  return {
    get: api.get.handler(({ context, input }) =>
      getWordImport(context.tx, { kind: "user", userId: context.user.id }, input.importId),
    ),
    list: api.list.handler(({ context, input }) =>
      listWordImports(context.tx, { kind: "user", userId: context.user.id }, input),
    ),
    file: api.file.handler(({ context, input }) =>
      getWordImportFile(context.tx, { kind: "user", userId: context.user.id }, input.fileId),
    ),
    update: api.update.handler(({ context, input }) =>
      updateWordImportFile(context.tx, deps.jobs, { kind: "user", userId: context.user.id }, input),
    ),
    cancel: api.cancel.handler(({ context, input }) =>
      cancelWordImport(context.tx, { kind: "user", userId: context.user.id }, input.importId),
    ),
    ofDoc: api.ofDoc.handler(({ context, input }) =>
      wordImportOfDoc(context.tx, { kind: "user", userId: context.user.id }, input),
    ),
  };
}
