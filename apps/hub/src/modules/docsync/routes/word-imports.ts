import {
  WORD_IMPORT_ERRORS,
  type WordImport,
  type WordImportFile,
  type WordImportFileDetail,
  type WordImportGetOutput,
  type WordImportState,
  type WordImportUpdateInput,
  type WordImportWarning,
  wordImportMediaPath,
} from "@xdev-hive/contracts";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { authUser } from "../../identity/index.ts";
import { authorize, docScope, getDoc, type Principal, type Reader, readerFor } from "../../knowledge/index.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  type Jobs,
  NotFoundError,
  type Tx,
} from "../../platform/index.ts";
import type { HomeRow } from "../homes.ts";
import { keyFromPath, type PathHome } from "../paths.ts";
import { pathHomeOf, projectKeyOf } from "../push.ts";
import { queueWordDoc, queueWordImport } from "../queues.ts";
import { docHomes, docWordImportFiles, docWordImports } from "../schema.ts";
import { refreshWordImportCounts } from "../word/convert.ts";
import { frontMatter } from "../word/postprocess.ts";
import type { WordImportFileRow, WordImportRow } from "../word/tools.ts";
import { type DocSyncRouteDeps, docSyncApi, notImplemented } from "./common.ts";

// Như word/commit.ts của T010: chưa có chỗ chung nên mỗi bên giữ một bản, gộp khi cả hai vào main.

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

interface WordTarget {
  imp: WordImportRow;
  home: HomeRow;
  pathHome: PathHome;
}

async function loadTarget(tx: Tx, importId: string, lock = false): Promise<WordTarget> {
  const query = tx.select().from(docWordImports).where(eq(docWordImports.id, importId));
  const [imp] = lock ? await query.for("update") : await query;
  if (!imp) throw notFound();
  const [home] = await tx.select().from(docHomes).where(eq(docHomes.id, imp.homeId));
  if (!home) throw notFound();
  const pathHome = { ...pathHomeOf(home, await projectKeyOf(tx, home)), include: home.include, exclude: home.exclude };
  return { imp, home, pathHome };
}

const pathOf = (file: WordImportFileRow): string | null => file.pathOverride ?? file.proposedPath;

/** Key suy từ đường dẫn; null khi đường dẫn nằm ngoài thư mục tài liệu của nhà hoặc bị loại trừ. */
function keyOfPath(target: WordTarget, path: string | null): string | null {
  if (!path) return null;
  const root = target.home.root.replace(/\/+$/, "");
  if (root && !path.startsWith(`${root}/`)) return null;
  try {
    return keyFromPath(path, target.pathHome);
  } catch {
    return null;
  }
}

async function docKeyOf(tx: Tx, docId: string | null): Promise<string | null> {
  if (!docId) return null;
  const { rows } = await tx.execute<{ key: string }>(sql`select key from hive.docs where id = ${docId}`);
  return rows[0]?.key ?? null;
}

async function canManage(tx: Tx, reader: Reader, key: string): Promise<boolean> {
  try {
    await authorize(tx, reader, await docScope(tx, reader, key), "manage");
    return true;
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof NotFoundError) return false;
    throw error;
  }
}

/** Key đại diện cho phạm vi đích: thư mục đích khi tạo, tài liệu đích khi cập nhật hay gắn. */
async function scopeKeyOf(tx: Tx, target: WordTarget): Promise<string | null> {
  const { imp } = target;
  if (imp.mode !== "create") return docKeyOf(tx, imp.updateDocId);
  const dir = imp.targetDir ? `${imp.targetDir.replace(/\/+$/, "")}/` : "";
  return keyOfPath(target, `${dir}word-import.md`);
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
  if (key && (await canManage(tx, await readerFor(tx, principal), key))) return "manage";
  return principal.kind === "user" && target.imp.createdBy === principal.userId ? "propose" : null;
}

export async function loadVisible(tx: Tx, principal: Principal, importId: string, lock = false) {
  const target = await loadTarget(tx, importId, lock);
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

interface FilePlace {
  path: string | null;
  key: string | null;
  exists: boolean;
}

function fileView(file: WordImportFileRow, place: FilePlace): WordImportFile {
  return {
    id: file.id,
    importId: file.importId,
    relativeDir: file.relativeDir,
    fileName: file.fileName,
    format: file.format as WordImportFile["format"],
    size: file.size,
    sha256: file.sha256,
    versionLabel: file.versionLabel,
    proposedPath: file.proposedPath,
    proposedTitle: file.proposedTitle,
    path: place.path,
    title: file.titleOverride ?? file.proposedTitle,
    key: place.key,
    exists: place.exists,
    keepFront: file.keepFront,
    excluded: file.excluded,
    state: file.state as WordImportFile["state"],
    stats: file.stats ?? null,
    warnings: file.warnings as WordImportWarning[],
    findings: file.findings as WordImportFile["findings"],
    error: (file.error as WordImportFile["error"]) ?? null,
    linkMatches: file.linkMatches,
    docId: file.docId,
    docVersion: file.docVersion,
    proposalId: file.proposalId,
    createdAt: file.createdAt.toISOString(),
    updatedAt: file.updatedAt.toISOString(),
  };
}

/** Vị trí của các file; một truy vấn cho mọi key thay vì một truy vấn mỗi file. */
async function filePlaces(tx: Tx, target: WordTarget, files: WordImportFileRow[]): Promise<Map<string, FilePlace>> {
  const docKey = target.imp.mode === "create" ? null : await docKeyOf(tx, target.imp.updateDocId);
  const keys = new Map(
    files.map((f) => [f.id, target.imp.mode === "create" ? keyOfPath(target, pathOf(f)) : docKey] as const),
  );
  const wanted = [...new Set([...keys.values()].filter((k): k is string => k !== null))];
  const existing = new Set<string>();
  if (wanted.length) {
    const { rows } = await tx.execute<{ key: string }>(
      sql`select key from hive.docs where key in (${sql.join(
        wanted.map((k) => sql`${k}`),
        sql`, `,
      )})`,
    );
    for (const r of rows) existing.add(r.key);
  }
  return new Map(
    files.map((f) => {
      const key = keys.get(f.id) ?? null;
      return [f.id, { path: pathOf(f), key, exists: key !== null && existing.has(key) }];
    }),
  );
}

async function placeOf(tx: Tx, target: WordTarget, file: WordImportFileRow): Promise<FilePlace> {
  return (await filePlaces(tx, target, [file])).get(file.id) ?? { path: null, key: null, exists: false };
}

async function importView(tx: Tx, imp: WordImportRow, names?: Map<string, string | null>): Promise<WordImport> {
  let name = names?.get(imp.createdBy);
  if (name === undefined) {
    const [creator] = await tx.select({ name: authUser.name }).from(authUser).where(eq(authUser.id, imp.createdBy));
    name = creator?.name ?? null;
    names?.set(imp.createdBy, name);
  }
  return {
    id: imp.id,
    homeId: imp.homeId,
    targetDir: imp.targetDir,
    mode: imp.mode as WordImport["mode"],
    docKey: await docKeyOf(tx, imp.updateDocId),
    confidential: imp.confidential,
    state: imp.state as WordImport["state"],
    counts: imp.counts,
    createdBy: { id: imp.createdBy, name },
    createdAt: imp.createdAt.toISOString(),
    updatedAt: imp.updatedAt.toISOString(),
  };
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
    import: await importView(tx, target.imp),
    files: files.map((f) => fileView(f, places.get(f.id) ?? { path: null, key: null, exists: false })),
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
          target = await loadTarget(tx, imp.id);
          targets.set(imp.homeId, target);
        }
        ok = (await wordImportAccess(tx, principal, { ...target, imp })) !== null;
        access.set(cacheKey, ok);
      }
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
  for (const imp of page) items.push(await importView(tx, imp, names));
  const tail = page.at(-1);
  return {
    items,
    nextCursor: visible.length > input.limit && tail ? `${tail.createdAt.toISOString()}|${tail.id}` : null,
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
    ...fileView(file, await placeOf(tx, target, file)),
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

/** Key hoặc đường dẫn đã có tài liệu (FR-019); đường dẫn so không phân biệt hoa thường như repo trên Windows, macOS. */
async function taken(tx: Tx, home: HomeRow, key: string, path: string): Promise<boolean> {
  const { rows } = await tx.execute(sql`
    select 1 from hive.docs where key = ${key}
    union all
    select 1 from hive.doc_repo_files where home_id = ${home.id} and lower(repo_path) = lower(${path})
    limit 1`);
  return rows.length > 0;
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
  await refreshWordImportCounts(tx, target.imp.id);
  return fileView(saved, await placeOf(tx, target, saved));
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
    await refreshWordImportCounts(tx, imp.id);
  }
  const [saved] = await tx.select().from(docWordImports).where(eq(docWordImports.id, imp.id));
  if (!saved) throw notFound();
  return importView(tx, saved);
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
    ofDoc: api.ofDoc.handler(() => notImplemented()),
  };
}
