import { sql } from "drizzle-orm";
import { keyFromPath } from "../docsync/index.ts";
import type { DocSavedEvent } from "../knowledge/index.ts";
import type { Tx } from "../platform/index.ts";
import { type AreaFile, applyAreaFile, archiveAreaDoc } from "./library.ts";

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
  await applyDoc(tx, prefix, {
    projectId: row.project_id,
    docId: event.docId,
    docKey: event.key,
    docVersion: event.version,
    content: row.content,
    archived: event.change === "archive",
  });
}

async function applyDoc(
  tx: Tx,
  prefix: string | null,
  doc: Omit<AreaFile, "content"> & { content: string | null; archived: boolean },
): Promise<void> {
  // Tài liệu chuyển ra khỏi thư mục TC thì khu của nó thành lưu trữ, như khi lưu trữ tài liệu.
  if (doc.archived || !prefix || !doc.docKey.startsWith(prefix)) {
    await archiveAreaDoc(tx, doc.docId);
    return;
  }
  if (doc.content === null) return;
  await applyAreaFile(tx, { ...doc, content: doc.content });
}

/**
 * Đọc lại thư mục TC khi bật thư viện hoặc đổi thư mục: hook bỏ qua mọi lần lưu lúc thư viện tắt, còn khu của thư mục
 * cũ phải thành lưu trữ. Khu ra khỏi thư mục chạy trước để mã khu nó nhả ra dùng lại được trong cùng lượt.
 */
export async function syncProjectLibrary(
  tx: Tx,
  project: { projectId: string; projectKey: string; tcDir: string },
): Promise<void> {
  const prefix = areaKeyPrefix(project.projectKey, project.tcDir);
  const { rows } = await tx.execute<{
    id: string;
    key: string;
    version: number;
    content: string;
    archived: boolean;
  }>(sql`
    select d.id, d.key, d.current_version as version, v.content, d.archived_at is not null as archived
      from hive.docs d
      join hive.doc_versions v on v.doc_id = d.id and v.version = d.current_version
     where d.project_id = ${project.projectId}
       and ((${prefix}::text is not null and starts_with(d.key, ${prefix}))
         or d.id in (select doc_id from hive.qa_areas where project_id = ${project.projectId}))
     order by d.key`);
  const inDir = (key: string) => !!prefix && key.startsWith(prefix);
  rows.sort((a, b) => Number(inDir(a.key)) - Number(inDir(b.key)));
  for (const row of rows)
    await applyDoc(tx, prefix, {
      projectId: project.projectId,
      docId: row.id,
      docKey: row.key,
      docVersion: row.version,
      content: row.content,
      archived: row.archived,
    });
}
