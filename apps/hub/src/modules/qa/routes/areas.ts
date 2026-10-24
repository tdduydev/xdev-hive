import { areaTemplate, type TestArea } from "@xdev-hive/contracts";
import { and, asc, eq, type SQL, sql } from "drizzle-orm";
import { saveDoc } from "../../knowledge/index.ts";
import type { Tx } from "../../platform/index.ts";
import { qaError, qaProject } from "../access.ts";
import { type QaRouteDeps, qaApi } from "../deps.ts";
import { areaKeyPrefix } from "../doc-hooks.ts";
import { qaAreas } from "../schema.ts";

// Viết tên bảng tay: select không join thì drizzle bỏ tên bảng ở cột, `area_id = id` sẽ so cột của chính qa_cases.
const activeCases = sql<number>`(select count(*)::int from hive.qa_cases c
  where c.area_id = hive.qa_areas.id and c.state = 'active')`;

async function selectAreas(tx: Tx, where: SQL): Promise<TestArea[]> {
  const rows = await tx
    .select({
      id: qaAreas.id,
      code: qaAreas.code,
      name: qaAreas.name,
      docKey: qaAreas.docKey,
      activeCases,
      parsedVersion: qaAreas.parsedVersion,
      parseErrors: qaAreas.parseErrors,
      errorsVersion: qaAreas.errorsVersion,
      archivedAt: qaAreas.archivedAt,
    })
    .from(qaAreas)
    .where(where)
    .orderBy(asc(qaAreas.code));
  return rows.map(({ archivedAt, ...r }) => ({ ...r, archived: archivedAt !== null }));
}

export async function listAreas(tx: Tx, userId: string, projectKey: string): Promise<{ items: TestArea[] }> {
  const { project } = await qaProject(tx, userId, projectKey, "qa.read");
  return { items: await selectAreas(tx, eq(qaAreas.projectId, project.id)) };
}

/**
 * Tạo file khu từ mẫu FR-008 qua `saveDoc`, nên quyền lưu, quét bí mật, audit và đồng bộ repo như mọi tài liệu. Khu
 * do hook lưu tạo trong cùng tx; ở đây chỉ đọc lại.
 */
export async function createArea(
  tx: Tx,
  userId: string,
  input: { projectKey: string; code: string; name: string },
): Promise<{ area: TestArea; docKey: string }> {
  const { project, settings } = await qaProject(tx, userId, input.projectKey, "qa.cases.write");
  const [holder] = await tx
    .select({ docId: qaAreas.docId, docKey: qaAreas.docKey })
    .from(qaAreas)
    .where(and(eq(qaAreas.projectId, project.id), eq(qaAreas.code, input.code)));
  // Khu mất tài liệu (tài liệu bị xoá) thì file mới nhận lại khu, như khi lưu file cùng mã khu ở editor.
  if (holder?.docId) throw qaError("QA_AREA_CODE_TAKEN", { KHU: input.code, "đường dẫn": holder.docKey });
  const prefix = areaKeyPrefix(project.key, settings.tcDir);
  if (!prefix) throw new Error("Thư mục TC không tạo được key tài liệu.");
  const doc = await saveDoc(
    tx,
    { kind: "user", userId },
    {
      key: `${prefix}${input.code.toLowerCase()}`,
      title: `${input.code} ${input.name}`,
      content: areaTemplate(input.code, input.name),
      baseVersion: 0,
    },
  );
  const [area] = await selectAreas(tx, eq(qaAreas.docId, doc.id));
  if (!area) throw new Error("Không ghi được thư viện test case.");
  return { area, docKey: doc.key };
}

export function areasRoutes(deps: QaRouteDeps) {
  const api = qaApi(deps).areas;
  return {
    list: api.list.handler(({ context, input }) => listAreas(context.tx, context.user.id, input.projectKey)),
    create: api.create.handler(({ context, input }) => createArea(context.tx, context.user.id, input)),
  };
}
