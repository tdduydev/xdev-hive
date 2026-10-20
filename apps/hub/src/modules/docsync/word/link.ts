import type { WordImportFile } from "@xdev-hive/contracts";
import { eq, sql } from "drizzle-orm";
import { recordAudit } from "../../audit/index.ts";
import { authorize, docScope, type Principal, readerFor } from "../../knowledge/index.ts";
import { BadRequestError, NotFoundError, type Tx } from "../../platform/index.ts";
import { docWordImportFiles } from "../schema.ts";
import { filePlaces, loadWordTarget, refreshWordImport, stripFrontMatter, wordFileView } from "./commit.ts";
import type { WordImportFileRow } from "./tools.ts";

// Đích link ảnh bất kỳ (tên băm của bản chuyển, `../assets/x.png` của tài liệu đang có).
const IMAGE_TARGET = /(!\[[^\]]*\]\()([^()\s]+)(\))/g;

/**
 * Dạng để so: bỏ front matter, xuống dòng LF, link ảnh chỉ còn tên ảnh, bỏ khoảng trắng cuối dòng và cuối bài. Hai bên
 * trỏ ảnh khác thư mục (bản chuyển chưa có đường dẫn) nên chỉ tên ảnh mới so được.
 */
export function linkComparable(markdown: string): string {
  return stripFrontMatter(markdown)
    .replace(/\r\n?/g, "\n")
    .replace(
      IMAGE_TARGET,
      (_all, open: string, target: string, close: string) => `${open}${target.split("/").at(-1)}${close}`,
    )
    .replace(/[ \t]+$/gm, "")
    .trim();
}

type LinkedDoc = {
  id: string;
  key: string;
  content: string;
};

async function linkedDoc(tx: Tx, docId: string | null): Promise<LinkedDoc | null> {
  if (!docId) return null;
  const { rows } = await tx.execute<LinkedDoc>(sql`
    select d.id, d.key, v.content
    from hive.docs d
    join hive.doc_versions v on v.doc_id = d.id and v.version = d.current_version
    where d.id = ${docId}`);
  return rows[0] ?? null;
}

/**
 * Lượt `link` (FR-028, plan.md mục 8b): job chuyển gọi sau khi file `ready`, so với nội dung hiện tại của tài liệu đích.
 * Khớp thì file `done` không có `doc_version`, không thì chờ `confirmLink`. Không ghi ảnh vào nhà: tài liệu đã có ảnh
 * của nó, bản chuyển chỉ dùng làm gốc để lần nhập sau so.
 */
export async function prepareLink(tx: Tx, file: WordImportFileRow): Promise<void> {
  // Chưa chuyển xong thì chưa có gì để so.
  if (file.markdown == null) return;
  const target = await loadWordTarget(tx, file.importId);
  if (target.imp.mode !== "link") return;
  const doc = await linkedDoc(tx, target.imp.updateDocId);
  if (!doc) return;
  const matches = linkComparable(file.markdown) === linkComparable(doc.content);
  await tx
    .update(docWordImportFiles)
    .set(
      matches
        ? { state: "done", linkMatches: true, docId: doc.id, docVersion: null, updatedAt: new Date() }
        : { linkMatches: false, updatedAt: new Date() },
    )
    .where(eq(docWordImportFiles.id, file.id));
  await refreshWordImport(tx, target.imp.id);
}

/** Người gắn chọn "Lấy bản chuyển làm gốc" khi kết quả không khớp nội dung hiện tại. */
export async function confirmLink(tx: Tx, principal: Principal, input: { fileId: string }): Promise<WordImportFile> {
  const [file] = await tx
    .select()
    .from(docWordImportFiles)
    .where(eq(docWordImportFiles.id, input.fileId))
    .for("update");
  if (!file) throw new NotFoundError("WORD_IMPORT_FILE_NOT_FOUND", "Không tìm thấy file trong lượt nhập Word.");
  const target = await loadWordTarget(tx, file.importId);
  if (target.imp.mode !== "link")
    throw new BadRequestError("WORD_IMPORT_NOT_LINK", "Lượt nhập này không phải gắn tài liệu có sẵn.");
  if (file.state !== "ready" || file.markdown == null)
    throw new BadRequestError("WORD_IMPORT_FILE_NOT_READY", "File chưa chuyển xong hoặc đã được xử lý.");
  const doc = await linkedDoc(tx, target.imp.updateDocId);
  if (!doc) throw new NotFoundError("DOC_NOT_FOUND", "Không tìm thấy tài liệu cần gắn.");
  const reader = await readerFor(tx, principal);
  await authorize(tx, reader, await docScope(tx, reader, doc.key), "manage");
  const [saved] = await tx
    .update(docWordImportFiles)
    .set({ state: "done", docId: doc.id, docVersion: null, updatedAt: new Date() })
    .where(eq(docWordImportFiles.id, file.id))
    .returning();
  // Gắn khi nội dung khác nhau là quyết định của người gắn, nên lưu lại ai đã chọn và chọn bản nào.
  await recordAudit(tx, {
    action: "docs.word_link_confirm",
    targetType: "doc",
    targetId: doc.id,
    data: { importId: target.imp.id, fileId: file.id, docKey: doc.key, sha256: file.sha256, matches: file.linkMatches },
  });
  await refreshWordImport(tx, target.imp.id);
  const row = saved ?? file;
  const places = await filePlaces(tx, target, [row]);
  return wordFileView(row, places.get(row.id) ?? { path: null, key: doc.key, exists: true });
}
