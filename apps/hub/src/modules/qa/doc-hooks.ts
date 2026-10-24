import { sql } from "drizzle-orm";
import { keyFromPath } from "../docsync/index.ts";
import type { DocSavedEvent } from "../knowledge/index.ts";
import type { Tx } from "../platform/index.ts";
import { applyAreaFile, archiveAreaDoc } from "./library.ts";

// Hook lưu tài liệu (research D3). Sửa trên web và đồng bộ từ repo đều qua `docChanged()`, nên một hook phủ cả hai
// phía (FR-005). Chạy trong tx lưu: chỉ throw khi database lỗi, lỗi nội dung đã nằm ở `qa_areas.parse_errors`.

/** Tiền tố key của thư mục TC. Key tài liệu đã qua slug từng đoạn, nên dựng bằng chính hàm docsync dùng. */
export function areaKeyPrefix(projectKey: string, tcDir: string): string | null {
  const sample = keyFromPath(`${tcDir}a.md`, { scope: "project", projectKey, root: "" });
  return sample ? sample.slice(0, -1) : null;
}

export async function qaDocSaved(tx: Tx, event: DocSavedEvent): Promise<void> {
  const projectKey = /^project\/([a-z0-9-]+)\//.exec(event.key)?.[1];
  if (!projectKey) return;
  const { rows } = await tx.execute<{ project_id: string; tc_dir: string; content: string | null }>(sql`
    select s.project_id, s.tc_dir, v.content
      from hive.docs d
      join hive.qa_project_settings s on s.project_id = d.project_id and s.enabled
      left join hive.doc_versions v on v.doc_id = d.id and v.version = ${event.version}
     where d.id = ${event.docId}`);
  const row = rows[0];
  if (!row) return;
  const prefix = areaKeyPrefix(projectKey, row.tc_dir);
  // Tài liệu chuyển ra khỏi thư mục TC thì khu của nó thành lưu trữ, như khi lưu trữ tài liệu.
  if (event.change === "archive" || !prefix || !event.key.startsWith(prefix)) {
    await archiveAreaDoc(tx, event.docId);
    return;
  }
  if (row.content === null) return;
  await applyAreaFile(tx, {
    projectId: row.project_id,
    docId: event.docId,
    docKey: event.key,
    docVersion: event.version,
    content: row.content,
  });
}
