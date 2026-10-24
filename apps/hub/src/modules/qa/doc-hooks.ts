import { sql } from "drizzle-orm";
import { keyFromPath } from "../docsync/index.ts";
import type { DocAccessFor, DocSavedEvent } from "../knowledge/index.ts";
import type { Tx } from "../platform/index.ts";
import { effectivePermissions } from "../tenancy/index.ts";
import { type AreaFile, applyAreaFile, archiveAreaDoc } from "./library.ts";

// Hook lưu tài liệu (research D3). Sửa trên web và đồng bộ từ repo đều qua `docChanged()`, nên một hook phủ cả hai
// phía (FR-005). Chạy trong tx lưu: chỉ throw khi database lỗi, lỗi nội dung đã nằm ở `qa_areas.parse_errors`.

/** Tiền tố key của thư mục TC. Key tài liệu đã qua slug từng đoạn, nên dựng bằng chính hàm docsync dùng. */
export function areaKeyPrefix(projectKey: string, tcDir: string): string | null {
  const sample = keyFromPath(`${tcDir}a.md`, { scope: "project", projectKey, root: "" });
  return sample ? sample.slice(0, -1) : null;
}

const projectKeyOf = (key: string) => /^project\/([a-z0-9-]+)\//.exec(key)?.[1];

/**
 * Provider quyền lưu (D4, FR-011): người có `qa.cases.write` ở đội sở hữu lưu thẳng được file trong thư mục TC dù
 * không có `docs.write`. Chạy ở mọi lần đọc và lưu tài liệu của dự án, nên lọc theo key trước khi hỏi database.
 */
export const qaDocAccess: DocAccessFor = async (tx, reader, key) => {
  if (reader.kind !== "user") return null;
  const projectKey = projectKeyOf(key);
  if (!projectKey) return null;
  const { rows } = await tx.execute<{ team_id: string; tc_dir: string }>(sql`
    select p.team_id, s.tc_dir
      from hive.projects p
      join hive.qa_project_settings s on s.project_id = p.id and s.enabled
     where p.key = ${projectKey}`);
  const row = rows[0];
  const prefix = row ? areaKeyPrefix(projectKey, row.tc_dir) : null;
  if (!row || !prefix || !key.startsWith(prefix) || !reader.teams.has(row.team_id)) return null;
  const permissions = await effectivePermissions(tx, reader.principal.userId, row.team_id);
  return permissions.has("qa.cases.write") ? { read: true, propose: true, save: true } : null;
};

export async function qaDocSaved(tx: Tx, event: DocSavedEvent): Promise<void> {
  const projectKey = projectKeyOf(event.key);
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
