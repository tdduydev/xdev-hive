import { createHash } from "node:crypto";
import {
  type Doc,
  type DocGetInput,
  type DocListInput,
  type DocSaveInput,
  type DocSummary,
  type DocVersion,
  type DocVersionSource,
  docGetInput,
  docKey,
  docListInput,
  docSaveInput,
  SECRET_KIND_LABELS,
  type SecretFinding,
  scanSecrets,
} from "@xdev-hive/contracts";
import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { auditByData } from "../audit/index.ts";
import { BadRequestError, ConflictError, NotFoundError, type Tx } from "../platform/index.ts";
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
import { queueDocIndex } from "./doc-search.ts";
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
  // Tester đọc được mọi tài liệu của đội nhưng chỉ lưu thẳng file TC, nên cấp lưu được hỏi cả khi đã đọc được, cả với
  // tài liệu chưa có.
  const grant = await docGrant(tx, reader, key);
  const saveGranted = grant?.save === true;
  if (!d) return { ...(await scopeOfDocKey(tx, reader, key)), saveGranted };
  if (canRead(reader, d)) return { teamId: d.teamId, projectId: d.projectId, saveGranted };
  if (!grant) throw notFound();
  return { teamId: d.teamId, projectId: d.projectId, proposeGranted: grant.propose, saveGranted };
}

/** Phiên bản hiện tại của tài liệu theo key (0 khi chưa có). Dùng khi tạo đề xuất để báo sớm base đã cũ. */
export async function currentDocVersion(tx: Tx, key: string): Promise<number> {
  return (await loadDoc(tx, key))?.currentVersion ?? 0;
}

/**
 * Nguồn của phiên bản: `repo` đã có sẵn trong repo nên đồng bộ không đẩy lại; `import` và `merge` do docsync tạo;
 * `word` là bản nhập từ Word, được đẩy như `hub`.
 */
export type DocSource = DocVersionSource;

/** Người lưu của phiên bản do đồng bộ tạo; như `AI_AUTO_ACTOR`, không phải người dùng thật nên không mang quyền gì. */
export const DOC_SYNC_ACTOR = "system:docsync";

export interface DocSavedEvent {
  orgId: string;
  docId: string;
  key: string;
  version: number;
  source: DocSource;
  /** Lưu trữ và khôi phục không tạo phiên bản mới nhưng repo vẫn phải xoá hoặc ghi lại file. */
  change: "save" | "archive" | "restore";
}
export type DocSavedHook = (tx: Tx, event: DocSavedEvent) => Promise<void>;

// docsync và qa phụ thuộc knowledge nên không import ngược được; hook tiêm lúc khởi động như provideDocAccess. Gọi
// trong transaction lưu để job đẩy chỉ được xếp, và thư viện TC chỉ đổi, khi phiên bản thật sự được ghi.
const docSavedHooks = new Set<DocSavedHook>();
/** Thêm một hook, trả hàm gỡ nó. `undefined` gỡ mọi hook (test dọn sau mỗi ca). */
export function provideDocSaved(hook: DocSavedHook | undefined): () => void {
  if (!hook) {
    docSavedHooks.clear();
    return () => {};
  }
  docSavedHooks.add(hook);
  return () => docSavedHooks.delete(hook);
}

async function docChanged(tx: Tx, row: DocRow, source: DocSource, change: DocSavedEvent["change"]): Promise<void> {
  // Chỉ mục tìm kiếm là việc của chính knowledge nên không đi qua hook của module khác.
  await queueDocIndex(tx, { orgId: row.orgId, docId: row.id });
  const event = { orgId: row.orgId, docId: row.id, key: row.key, version: row.currentVersion, source, change };
  // Tuần tự trong cùng transaction; một hook lỗi thì cả lần lưu bị huỷ.
  for (const hook of docSavedHooks) await hook(tx, event);
}

/** Cùng cách tính với migration điền `content_hash` cho dòng cũ: sha256 của chuỗi UTF-8 nguyên văn. */
export const docContentHash = (content: string): string => createHash("sha256").update(content).digest("hex");

// ---- Bí mật --------------------------------------------------------------------------------------------------------

const SECRET_ACK = "doc.secrets.acknowledge";

/** Mang dòng và loại để router trả kèm lỗi; không bao giờ mang chuỗi bí mật. */
export class DocSecretError extends BadRequestError {
  readonly findings: SecretFinding[];

  constructor(findings: SecretFinding[]) {
    const where = findings
      .slice(0, 10)
      .map((f) => `dòng ${f.line} (${SECRET_KIND_LABELS[f.kind]})`)
      .join(", ");
    super("DOC_SECRET_FOUND", `Có chuỗi giống bí mật ở ${where}. Xoá hoặc xác nhận không phải bí mật trước khi lưu.`);
    this.findings = findings;
  }
}

/**
 * Nội dung này của tài liệu đã được người có quyền xác nhận không phải bí mật chưa. Xác nhận gắn với hash nội dung,
 * nên bước chốt của quy trình duyệt (chạy sau, có khi trong job) nhận ra bản đã xác nhận lúc gửi duyệt mà không cần
 * thêm cột; sửa nội dung thì phải xác nhận lại.
 */
export async function secretsAcknowledged(tx: Tx, key: string, content: string): Promise<boolean> {
  const rows = await auditByData(tx, {
    actionLike: SECRET_ACK,
    key: "contentHash",
    value: docContentHash(content),
    limit: 20,
  });
  return rows.some((r) => r.data.key === key);
}

/**
 * Chặn lưu nội dung giống bí mật (spec 018, mục Bí mật). `acknowledge` chỉ người có `manage` dùng được; xác nhận ghi
 * audit kèm loại và dòng, không kèm chuỗi.
 */
export async function assertDocSecrets(
  tx: Tx,
  principal: Principal,
  target: { reader: Reader; scope: Scope; key: string; content: string },
  acknowledge: boolean | undefined,
): Promise<void> {
  const findings = scanSecrets(target.content);
  if (findings.length === 0) return;
  if (!acknowledge) throw new DocSecretError(findings);
  await authorize(tx, target.reader, target.scope, "manage");
  await audit(
    tx,
    principal,
    SECRET_ACK,
    { type: "doc_key", id: target.key },
    { key: target.key, contentHash: docContentHash(target.content), findings },
  );
}

// ---- Lưu -----------------------------------------------------------------------------------------------------------

export interface DocWrite {
  key: string;
  title?: string | undefined;
  content: string;
  baseVersion: number;
  message?: string | undefined;
  source?: DocSource | undefined;
  repoCommit?: string | null | undefined;
  /** Đồng bộ đã có xác nhận riêng (từng file khi nhập) nên bỏ qua bước tra audit xác nhận. */
  secretsAcknowledged?: boolean | undefined;
}

/**
 * Lưu một phiên bản với khoá lạc quan: chỉ ghi khi phiên bản hiện tại đúng bằng baseVersion, nên hai người sửa từ
 * cùng một bản thì người lưu sau nhận CONFLICT thay vì ghi đè. Không kiểm quyền: saveDoc và duyệt đề xuất tự kiểm.
 *
 * Nội dung có dấu hiệu bí mật chưa được xác nhận thì phiên bản mang `secret_flag`: agent không đọc được, đồng bộ không
 * đẩy, không gửi embedding. Đường lưu của người (saveDoc, gửi duyệt) đã chặn trước; cờ là lưới cuối cho các đường còn
 * lại (duyệt tay đề xuất, kéo từ repo).
 */
export async function applyDocSave(
  tx: Tx,
  principal: Principal,
  scope: Scope,
  input: DocWrite,
  proposalId: string | null = null,
): Promise<Doc> {
  const author = authorColumns(principal);
  const source = input.source ?? "hub";
  const now = new Date();
  const secretFlag =
    !input.secretsAcknowledged &&
    scanSecrets(input.content).length > 0 &&
    !(await secretsAcknowledged(tx, input.key, input.content));
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
    contentHash: docContentHash(input.content),
    source,
    repoCommit: input.repoCommit ?? null,
    secretFlag,
    message: input.message ?? null,
    proposalId,
    ...author,
  });
  await docChanged(tx, row, source, "save");
  return { ...summary(row), content: input.content };
}

const archivedError = () =>
  new ConflictError("DOC_ARCHIVED", "Tài liệu đã được lưu trữ. Khôi phục tài liệu trước khi sửa.");

/** Người sửa trên hub không được ghi vào tài liệu đã lưu trữ: bản lưu sẽ không lên repo mà cũng không ai thấy. */
export async function assertNotArchived(tx: Tx, key: string): Promise<void> {
  if ((await loadDoc(tx, key))?.archivedAt) throw archivedError();
}

/**
 * Lưu tài liệu trực tiếp (quản trị đội của phạm vi). Phạm vi suy ra từ key. Chỉ module khác (nhập Word) mới đặt
 * `source`; oRPC không mở tham số này, nên người dùng không tự gắn được nguồn cho bản lưu của mình.
 */
export async function saveDoc(
  tx: Tx,
  principal: Principal,
  input: DocSaveInput,
  options: { source?: Extract<DocSource, "hub" | "word"> } = {},
): Promise<Doc> {
  const data = docSaveInput.parse(input);
  const reader = await readerFor(tx, principal);
  const scope = await docScope(tx, reader, data.key);
  await authorize(tx, reader, scope, "manage");
  await assertNotArchived(tx, data.key);
  await assertDocSecrets(
    tx,
    principal,
    { reader, scope, key: data.key, content: data.content },
    data.acknowledgeSecrets,
  );
  const doc = await applyDocSave(tx, principal, scope, { ...data, source: options.source });
  await audit(tx, principal, "doc.save", { type: "doc", id: doc.id }, { key: doc.key, version: doc.version });
  return doc;
}

export interface SyncDocWrite {
  key: string;
  title?: string | undefined;
  content: string;
  /** 0 là tạo mới. Lệch phiên bản hiện tại thì CONFLICT như saveDoc; docsync tự xử lý xung đột. */
  baseVersion: number;
  /** Phạm vi cho tài liệu mới, docsync suy từ nhà; tài liệu đã có giữ phạm vi đã lưu. */
  scope: Scope;
  source: Exclude<DocSource, "hub">;
  repoCommit?: string | null | undefined;
  /** Tác giả của commit trong repo; người lưu là hệ thống nên chỉ ghi lại ở đây. */
  message?: string | undefined;
  secretsAcknowledged?: boolean | undefined;
}

/**
 * Lưu phiên bản từ đồng bộ repo (kéo, nhập, hợp tự động): không qua duyệt, không kiểm quyền, người lưu là hệ thống.
 * Không nhận principal để không cấp quyền gì cho run hay người gọi. Bí mật không chặn để hub không lệch repo; phiên
 * bản mang `secret_flag` và người gọi đánh dấu file `blocked_secret`.
 */
export async function saveDocFromSync(tx: Tx, input: SyncDocWrite): Promise<Doc & { secretFlag: boolean }> {
  const key = docKey.parse(input.key);
  const existing = await loadDoc(tx, key);
  const scope: Scope = existing
    ? { teamId: existing.teamId, projectId: existing.projectId }
    : { teamId: input.scope.teamId, projectId: input.scope.projectId };
  const doc = await applyDocSave(tx, { kind: "user", userId: DOC_SYNC_ACTOR }, scope, { ...input, key });
  const [v] = await tx
    .select({ secretFlag: docVersions.secretFlag })
    .from(docVersions)
    .where(and(eq(docVersions.docId, doc.id), eq(docVersions.version, doc.version)));
  return { ...doc, secretFlag: v?.secretFlag ?? false };
}

// ---- Lưu trữ -------------------------------------------------------------------------------------------------------

const archiveInput = z.object({ key: docKey, baseVersion: z.number().int().min(1) });
export type DocArchiveInput = z.input<typeof archiveInput>;

/** Tài liệu người gọi quản trị được, đúng phiên bản đã thấy, để không lưu trữ nhầm bản người khác vừa sửa. */
async function managed(tx: Tx, principal: Principal, input: DocArchiveInput): Promise<DocRow> {
  const data = archiveInput.parse(input);
  const reader = await readerFor(tx, principal);
  const d = await readable(tx, reader, data.key);
  await authorize(tx, reader, d, "manage");
  if (d.currentVersion !== data.baseVersion) throw versionConflict("Tài liệu", d.currentVersion, data.baseVersion);
  return d;
}

/** Lưu trữ (FR-024): ẩn khỏi danh sách, tìm kiếm và MCP, lịch sử giữ nguyên; lô đồng bộ kế tiếp xoá file trong repo. */
export async function archiveDoc(tx: Tx, principal: Principal, input: DocArchiveInput): Promise<void> {
  const d = await managed(tx, principal, input);
  if (d.archivedAt) return;
  const [row] = await tx.update(docs).set({ archivedAt: new Date() }).where(eq(docs.id, d.id)).returning();
  await audit(tx, principal, "doc.archive", { type: "doc", id: d.id }, { key: d.key, version: d.currentVersion });
  if (row) await docChanged(tx, row, "hub", "archive");
}

/** Khôi phục tài liệu đã lưu trữ; lô đồng bộ kế tiếp ghi lại file vào repo. */
export async function restoreDoc(tx: Tx, principal: Principal, input: DocArchiveInput): Promise<Doc> {
  const d = await managed(tx, principal, input);
  if (d.archivedAt) {
    const [row] = await tx.update(docs).set({ archivedAt: null }).where(eq(docs.id, d.id)).returning();
    await audit(tx, principal, "doc.restore", { type: "doc", id: d.id }, { key: d.key, version: d.currentVersion });
    if (row) await docChanged(tx, row, "hub", "restore");
  }
  return getDoc(tx, principal, { key: d.key });
}

// ---- Đọc -----------------------------------------------------------------------------------------------------------

/**
 * Phiên bản có dấu hiệu bí mật chưa xác nhận không đưa cho agent (FR-038): agent có thể chép nó vào log, commit hay
 * prompt của nhà cung cấp khác.
 */
const flaggedCurrent = sql`exists (select 1 from ${docVersions} v where v.doc_id = ${docs.id} and v.version = ${docs.currentVersion} and v.secret_flag)`;

/**
 * Đọc tài liệu theo key, mặc định phiên bản mới nhất. Hàm public cho MCP. Tài liệu đã lưu trữ chỉ đọc được khi chỉ
 * rõ phiên bản (xem lịch sử), và agent không đọc được.
 */
export async function getDoc(tx: Tx, principal: Principal, input: DocGetInput): Promise<Doc> {
  const data = docGetInput.parse(input);
  const reader = await readerFor(tx, principal);
  const d = await readable(tx, reader, data.key);
  if (d.archivedAt && (data.version === undefined || reader.kind === "run")) throw notFound();
  const version = data.version ?? d.currentVersion;
  const [v] = await tx
    .select()
    .from(docVersions)
    .where(and(eq(docVersions.docId, d.id), eq(docVersions.version, version)));
  if (!v) throw new NotFoundError("DOC_VERSION_NOT_FOUND", `Tài liệu không có phiên bản ${version}.`);
  if (v.secretFlag && reader.kind === "run")
    throw new NotFoundError(
      "DOC_SECRET_FLAGGED",
      "Tài liệu có dấu hiệu bí mật, đang chờ người xác nhận hoặc sửa nên agent chưa đọc được.",
    );
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
  const archived = data.archived === true && reader.kind === "user";
  const rows = await tx
    .select()
    .from(docs)
    .where(
      and(
        visibleWhere(reader, docs, project),
        prefix ? sql`${docs.key} like ${`${prefix}%`}` : undefined,
        archived ? isNotNull(docs.archivedAt) : isNull(docs.archivedAt),
        reader.kind === "run" ? sql`not ${flaggedCurrent}` : undefined,
      ),
    )
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
      source: docVersions.source,
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
    // Cột có check theo đúng tập giá trị của contracts.
    source: r.source as DocSource,
    chars: r.chars,
    createdAt: iso(r.createdAt),
  }));
}
