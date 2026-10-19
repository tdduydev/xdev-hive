import { sql } from "drizzle-orm";
import type { BlobRefs } from "../../platform/index.ts";

/**
 * Nguồn tham chiếu blob cho GC (ADR 0028 mục 5): file Word gốc và ảnh giữ tạm của lượt nhập. Ảnh đã sang `doc_assets`
 * thì `doc_assets` giữ tham chiếu; dọn ảnh và file gốc là việc của lượt nhập, GC chỉ xoá blob không còn ai trỏ tới.
 */
export const wordImportBlobRefs: BlobRefs = async (tx, ids) => {
  if (!ids.length) return new Set();
  const list = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  // blobId trong jsonb so theo chuỗi; id của GC là uuid chữ thường như randomUUID ghi vào.
  const { rows } = await tx.execute<{ id: string }>(sql`
    select blob_id::text as id from hive.doc_word_import_files where blob_id = any(array[${list}]::uuid[])
    union
    select image->>'blobId' from hive.doc_word_import_files, jsonb_array_elements(images) image
     where image->>'blobId' = any(array[${list}]::text[])
  `);
  return new Set(rows.map((row) => row.id));
};
