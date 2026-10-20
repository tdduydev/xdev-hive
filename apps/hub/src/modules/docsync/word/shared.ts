import type { WordImport, WordImportFile, WordImportWarning } from "@xdev-hive/contracts";
import { count, eq, sql } from "drizzle-orm";
import { authUser } from "../../identity/index.ts";
import { authorize, docScope, type Reader } from "../../knowledge/index.ts";
import { ForbiddenError, NotFoundError, type Tx } from "../../platform/index.ts";
import type { HomeRow } from "../homes.ts";
import { keyFromPath, type PathHome } from "../paths.ts";
import { pathHomeOf, projectKeyOf } from "../push.ts";
import { docHomes, docWordImportFiles, docWordImports, type WordImportCountsRow } from "../schema.ts";
import type { WordImportFileRow, WordImportRow } from "./tools.ts";

// Hàm dùng chung của bước chuyển (convert.ts), bước tạo (commit.ts), gắn (link.ts) và route xem lượt nhập. File này
// không import các file đó để khỏi vòng phụ thuộc.

/** Lượt nhập kèm nhà và cách đọc đường dẫn của nhà, đọc một lần cho cả lượt. */
export interface WordTarget {
  imp: WordImportRow;
  home: HomeRow;
  pathHome: PathHome;
}

export async function loadWordTarget(tx: Tx, importId: string, lock = false): Promise<WordTarget> {
  const query = tx.select().from(docWordImports).where(eq(docWordImports.id, importId));
  // Khoá lượt để hai lần bấm "Tạo" liền nhau không cùng tạo một file.
  const [imp] = lock ? await query.for("update") : await query;
  if (!imp) throw new NotFoundError("WORD_IMPORT_NOT_FOUND", "Không tìm thấy lượt nhập Word.");
  const [home] = await tx.select().from(docHomes).where(eq(docHomes.id, imp.homeId));
  if (!home) throw new NotFoundError("WORD_IMPORT_NOT_FOUND", "Không tìm thấy lượt nhập Word.");
  const pathHome = { ...pathHomeOf(home, await projectKeyOf(tx, home)), include: home.include, exclude: home.exclude };
  return { imp, home, pathHome };
}

/** Đường dẫn người nhập đã sửa, không thì đường dẫn đề xuất. */
export const pathOf = (file: WordImportFileRow): string | null => file.pathOverride ?? file.proposedPath;

export const titleOf = (file: WordImportFileRow): string =>
  file.titleOverride ?? file.proposedTitle ?? file.fileName.replace(/\.[^.]+$/, "");

/** Key suy từ đường dẫn; null khi đường dẫn nằm ngoài nhà hoặc bị loại trừ. */
export function keyOfPath(target: WordTarget, path: string | null): string | null {
  if (!path) return null;
  const root = target.home.root.replace(/\/+$/, "");
  // Nhà dự án nhận cả đường dẫn ngoài gốc (`keyFromPath`), nhưng tài liệu nhập phải nằm trong thư mục tài liệu.
  if (root && !path.startsWith(`${root}/`)) return null;
  try {
    return keyFromPath(path, target.pathHome);
  } catch {
    return null;
  }
}

export async function docKeyOf(tx: Tx, docId: string | null): Promise<string | null> {
  if (!docId) return null;
  const { rows } = await tx.execute<{ key: string }>(sql`select key from hive.docs where id = ${docId}`);
  return rows[0]?.key ?? null;
}

/** Chỉ thiếu quyền mới thành false; phạm vi không thấy được (`NotFoundError`) vẫn ném, người gọi tự quyết. */
export async function canManage(tx: Tx, reader: Reader, key: string): Promise<boolean> {
  try {
    await authorize(tx, reader, await docScope(tx, reader, key), "manage");
    return true;
  } catch (error) {
    if (error instanceof ForbiddenError) return false;
    throw error;
  }
}

/** Key hoặc đường dẫn đã có tài liệu (FR-019). So đường dẫn không phân biệt hoa thường: repo trên Windows và macOS coi là một. */
export async function taken(tx: Tx, home: HomeRow, key: string, path: string): Promise<boolean> {
  const { rows } = await tx.execute(sql`
    select 1 from hive.docs where key = ${key}
    union all
    select 1 from hive.doc_repo_files where home_id = ${home.id} and lower(repo_path) = lower(${path})
    limit 1`);
  return rows.length > 0;
}

/** Key đại diện cho phạm vi đích: thư mục đích khi tạo, tài liệu đích khi cập nhật hay gắn. */
export async function scopeKeyOf(tx: Tx, target: WordTarget): Promise<string | null> {
  const { imp } = target;
  if (imp.mode !== "create") return docKeyOf(tx, imp.updateDocId);
  const dir = imp.targetDir ? `${imp.targetDir.replace(/\/+$/, "")}/` : "";
  return keyOfPath(target, `${dir}word-import.md`);
}

// ---- Dạng trả về ---------------------------------------------------------------------------------------------------

/** Key và đường dẫn hiện của file: lượt tạo suy từ đường dẫn, lượt cập nhật và gắn lấy theo tài liệu đích. */
export interface FilePlace {
  path: string | null;
  key: string | null;
  exists: boolean;
}

export const NO_PLACE: FilePlace = { path: null, key: null, exists: false };

export function wordFileView(file: WordImportFileRow, place: FilePlace): WordImportFile {
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

/** Vị trí của các file trong lượt; một truy vấn cho mọi key thay vì một truy vấn mỗi file. */
export async function filePlaces(
  tx: Tx,
  target: WordTarget,
  files: WordImportFileRow[],
): Promise<Map<string, FilePlace>> {
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

/** `names` cache tên người tạo khi dựng nhiều lượt liền nhau (danh sách). */
export async function wordImportOf(
  tx: Tx,
  imp: WordImportRow,
  names?: Map<string, string | null>,
): Promise<WordImport> {
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

// ---- Đếm lại lượt --------------------------------------------------------------------------------------------------

const COUNT_KEYS: Record<string, keyof WordImportCountsRow> = {
  queued: "queued",
  converting: "converting",
  ready: "ready",
  skipped: "skipped",
  blocked_secret: "blockedSecret",
  failed: "failed",
  proposed: "proposed",
  cancelled: "cancelled",
  done: "done",
};

/** Bên gọi đang ở bước nào quyết định luật chuyển trạng thái của lượt. */
export type WordImportPhase = "convert" | "commit";

/**
 * Đếm lại file theo trạng thái rồi chuyển trạng thái lượt theo bước của bên gọi.
 *
 * `convert` (job chuyển, sửa file, huỷ): chỉ lượt đang `converting` hay `ready` mới đổi trạng thái. Còn file chờ chuyển
 * thì `converting`, còn file chờ tạo thì `ready`, chuyển xong mà không còn gì để tạo thì `done`. Từ `ready` không tự
 * đóng lượt: người nhập bỏ hết file rồi vẫn phải bỏ chọn lại được.
 *
 * `commit` (bước tạo, gắn): không còn file chờ tạo thì lượt `done`, trừ lượt đang `uploading`, `failed`, `cancelled`.
 */
export async function refreshWordImportCounts(tx: Tx, importId: string, phase: WordImportPhase): Promise<void> {
  const rows = await tx
    .select({ state: docWordImportFiles.state, excluded: docWordImportFiles.excluded, n: count() })
    .from(docWordImportFiles)
    .where(eq(docWordImportFiles.importId, importId))
    .groupBy(docWordImportFiles.state, docWordImportFiles.excluded);
  const counts: WordImportCountsRow = {
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
  let converting = 0;
  let waiting = 0;
  for (const r of rows) {
    const key = COUNT_KEYS[r.state];
    if (key) counts[key] += r.n;
    if (r.state === "queued" || r.state === "converting") converting += r.n;
    if (!r.excluded && ["queued", "converting", "ready", "blocked_secret"].includes(r.state)) waiting += r.n;
  }
  const [imp] = await tx
    .select({ state: docWordImports.state })
    .from(docWordImports)
    .where(eq(docWordImports.id, importId));
  if (!imp) return;
  let next: WordImportRow["state"] | null = null;
  if (phase === "convert") {
    if (imp.state === "converting" || imp.state === "ready")
      next = converting > 0 ? "converting" : waiting > 0 ? "ready" : imp.state === "converting" ? "done" : imp.state;
  } else if (waiting === 0 && !["uploading", "failed", "cancelled"].includes(imp.state)) {
    next = "done";
  }
  await tx
    .update(docWordImports)
    .set({ counts, ...(next ? { state: next } : {}), updatedAt: new Date() })
    .where(eq(docWordImports.id, importId));
}
