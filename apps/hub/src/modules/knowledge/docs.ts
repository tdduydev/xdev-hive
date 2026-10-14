import {
  type Doc,
  type DocGetInput,
  type DocListInput,
  type DocSaveInput,
  type DocSummary,
  type DocVersion,
  docGetInput,
  docKey,
  docListInput,
  docSaveInput,
} from "@xdev-hive/contracts";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { NotFoundError, type Tx } from "../platform/index.ts";
import {
  audit,
  authorColumns,
  authorize,
  authorView,
  canRead,
  docGrant,
  iso,
  type Principal,
  projectContext,
  type Reader,
  readerFor,
  type Scope,
  scopeOfDocKey,
  scopeView,
  versionConflict,
  visibleWhere,
} from "./access.ts";
import { docs, docVersions } from "./schema.ts";

type DocRow = typeof docs.$inferSelect;

const notFound = () => new NotFoundError("DOC_NOT_FOUND", "Không tìm thấy tài liệu.");

function summary(d: DocRow): DocSummary {
  return {
    id: d.id,
    key: d.key,
    title: d.title,
    scope: scopeView(d),
    version: d.currentVersion,
    updatedAt: iso(d.updatedAt),
    updatedBy: { userId: d.updatedByUserId, runId: d.updatedByRunId },
  };
}

async function loadDoc(tx: Tx, key: string): Promise<DocRow | null> {
  const [row] = await tx.select().from(docs).where(eq(docs.key, key));
  return row ?? null;
}

/** Tài liệu mà người gọi đọc được; không thấy thì báo như không tồn tại. */
async function readable(tx: Tx, reader: Reader, key: string): Promise<DocRow> {
  const d = await loadDoc(tx, key);
  if (!d || !(canRead(reader, d) || (await docGrant(tx, reader, key))?.read)) throw notFound();
  return d;
}

/**
 * Phạm vi để kiểm quyền khi ghi theo key. Tài liệu đã có thì lấy phạm vi đã lưu chứ không giải lại từ key: đội đổi
 * slug thì key cũ trỏ tới đội khác (hoặc không đội nào), nhưng tài liệu vẫn thuộc đội cũ.
 */
export async function docScope(tx: Tx, reader: Reader, key: string): Promise<Scope> {
  const d = await loadDoc(tx, key);
  if (!d) return scopeOfDocKey(tx, reader, key);
  if (canRead(reader, d)) return d;
  const grant = await docGrant(tx, reader, key);
  if (!grant) throw notFound();
  return { teamId: d.teamId, projectId: d.projectId, proposeGranted: grant.propose };
}

/** Phiên bản hiện tại của tài liệu theo key (0 khi chưa có). Dùng khi tạo đề xuất để báo sớm base đã cũ. */
export async function currentDocVersion(tx: Tx, key: string): Promise<number> {
  return (await loadDoc(tx, key))?.currentVersion ?? 0;
}

export interface DocWrite {
  key: string;
  title?: string | undefined;
  content: string;
  baseVersion: number;
  message?: string | undefined;
}

/**
 * Lưu một phiên bản với khoá lạc quan: chỉ ghi khi phiên bản hiện tại đúng bằng baseVersion, nên hai người sửa từ
 * cùng một bản thì người lưu sau nhận CONFLICT thay vì ghi đè. Không kiểm quyền: saveDoc và duyệt đề xuất tự kiểm.
 */
export async function applyDocSave(
  tx: Tx,
  principal: Principal,
  scope: Scope,
  input: DocWrite,
  proposalId: string | null = null,
): Promise<Doc> {
  const author = authorColumns(principal);
  const now = new Date();
  let row: DocRow | undefined;
  if (input.baseVersion === 0) {
    // DO NOTHING thay vì bắt lỗi trùng khoá: lỗi trùng làm hỏng transaction, mà người gọi cần đọc phiên bản hiện tại
    // để báo xung đột.
    [row] = await tx
      .insert(docs)
      .values({
        orgId: sql`hive.ctx_org()`,
        teamId: scope.teamId,
        projectId: scope.projectId,
        key: input.key,
        title: input.title ?? input.key.split("/").at(-1) ?? input.key,
        currentVersion: 1,
        updatedByUserId: author.authorUserId,
        updatedByRunId: author.authorRunId,
      })
      .onConflictDoNothing()
      .returning();
  } else {
    [row] = await tx
      .update(docs)
      .set({
        currentVersion: sql`${docs.currentVersion} + 1`,
        ...(input.title ? { title: input.title } : {}),
        updatedByUserId: author.authorUserId,
        updatedByRunId: author.authorRunId,
        updatedAt: now,
      })
      .where(and(eq(docs.key, input.key), eq(docs.currentVersion, input.baseVersion)))
      .returning();
  }
  if (!row) throw versionConflict("Tài liệu", await currentDocVersion(tx, input.key), input.baseVersion);
  await tx.insert(docVersions).values({
    orgId: row.orgId,
    docId: row.id,
    version: row.currentVersion,
    title: row.title,
    content: input.content,
    message: input.message ?? null,
    proposalId,
    ...author,
  });
  return { ...summary(row), content: input.content };
}

/** Lưu tài liệu trực tiếp (quản trị đội của phạm vi). Phạm vi suy ra từ key. */
export async function saveDoc(tx: Tx, principal: Principal, input: DocSaveInput): Promise<Doc> {
  const data = docSaveInput.parse(input);
  const reader = await readerFor(tx, principal);
  const scope = await docScope(tx, reader, data.key);
  await authorize(tx, reader, scope, "manage");
  const doc = await applyDocSave(tx, principal, scope, data);
  await audit(tx, principal, "doc.save", { type: "doc", id: doc.id }, { key: doc.key, version: doc.version });
  return doc;
}

/** Đọc tài liệu theo key, mặc định phiên bản mới nhất. Hàm public cho MCP. */
export async function getDoc(tx: Tx, principal: Principal, input: DocGetInput): Promise<Doc> {
  const data = docGetInput.parse(input);
  const reader = await readerFor(tx, principal);
  const d = await readable(tx, reader, data.key);
  const version = data.version ?? d.currentVersion;
  const [v] = await tx
    .select()
    .from(docVersions)
    .where(and(eq(docVersions.docId, d.id), eq(docVersions.version, version)));
  if (!v) throw new NotFoundError("DOC_VERSION_NOT_FOUND", `Tài liệu không có phiên bản ${version}.`);
  return {
    ...summary(d),
    title: v.title,
    version: v.version,
    updatedAt: iso(v.createdAt),
    updatedBy: authorView(v),
    content: v.content,
  };
}

export async function listDocs(tx: Tx, principal: Principal, input: DocListInput): Promise<DocSummary[]> {
  const data = docListInput.parse(input);
  const reader = await readerFor(tx, principal);
  const project = await projectContext(tx, reader, data.project);
  // Thoát ký tự đại diện của LIKE để tiền tố là chữ thường, không phải mẫu.
  const prefix = data.prefix?.replace(/[\\%_]/g, (c) => `\\${c}`);
  const rows = await tx
    .select()
    .from(docs)
    .where(and(visibleWhere(reader, docs, project), prefix ? sql`${docs.key} like ${`${prefix}%`}` : undefined))
    .orderBy(asc(docs.key));
  return rows.map(summary);
}

export async function docHistory(tx: Tx, principal: Principal, input: { key: string }): Promise<DocVersion[]> {
  const key = docKey.parse(input.key);
  const reader = await readerFor(tx, principal);
  const d = await readable(tx, reader, key);
  const rows = await tx
    .select({
      version: docVersions.version,
      title: docVersions.title,
      authorUserId: docVersions.authorUserId,
      authorRunId: docVersions.authorRunId,
      message: docVersions.message,
      proposalId: docVersions.proposalId,
      chars: sql<number>`char_length(${docVersions.content})::int`,
      createdAt: docVersions.createdAt,
    })
    .from(docVersions)
    .where(eq(docVersions.docId, d.id))
    .orderBy(desc(docVersions.version));
  return rows.map((r) => ({
    version: r.version,
    title: r.title,
    author: authorView(r),
    message: r.message,
    proposalId: r.proposalId,
    chars: r.chars,
    createdAt: iso(r.createdAt),
  }));
}
