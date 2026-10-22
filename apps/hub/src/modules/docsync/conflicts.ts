import {
  type DocConflict,
  type DocConflictDetail,
  type DocConflictResolveInput,
  type DocSummary,
  docConflict,
  docConflictResolveInput,
  mergeBlocks,
  type SecretFinding,
  scanSecrets,
} from "@xdev-hive/contracts";
import { and, asc, eq, gt, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/index.ts";
import {
  archiveDoc,
  assertCanManageScope,
  docContentHash,
  getDoc,
  listDocs,
  type Principal,
  saveDocFromSync,
} from "../knowledge/index.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  type Jobs,
  NotFoundError,
  type Tx,
} from "../platform/index.ts";
import { markOrphanAssets } from "./asset-orphans.ts";
import { docLocation } from "./assets.ts";
import { contentHash, fromLf } from "./content.ts";
import type { DocSyncDeps } from "./routes/deps.ts";
import { docConflicts, docRepoFiles } from "./schema.ts";

type ConflictRow = typeof docConflicts.$inferSelect;
type FileRow = typeof docRepoFiles.$inferSelect;
type QueuePush = (tx: Tx, home: { orgId: string; homeId: string }) => Promise<unknown>;
const notFound = () => new NotFoundError("DOCSYNC_CONFLICT_NOT_FOUND", "Không tìm thấy xung đột tài liệu.");
const listInput = z.object({
  homeId: z.uuid().optional(),
  state: z.enum(["open", "resolved"]).default("open"),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export class ConflictSecretError extends BadRequestError {
  readonly findings: SecretFinding[];

  constructor(findings: SecretFinding[]) {
    super("DOC_SECRET_FOUND", "Nội dung có dấu hiệu bí mật. Xoá hoặc xác nhận không phải bí mật trước khi lưu.");
    this.findings = findings;
  }
}

// Chỉ dùng API public của knowledge để giữ nguyên quyền và phạm vi đã lưu, kể cả khi đội đổi slug.
async function managedDocs(tx: Tx, principal: Principal): Promise<DocSummary[]> {
  const visible = await listDocs(tx, principal, {});
  if (principal.kind !== "user") return [];
  const scopes = new Map<string, boolean>();
  const result: DocSummary[] = [];
  for (const doc of visible) {
    const scope = doc.scope.teamId ?? "org";
    let allowed = scopes.get(scope);
    if (allowed === undefined) {
      try {
        await assertCanManageScope(tx, principal.userId, doc.scope);
        allowed = true;
      } catch (error) {
        if (!(error instanceof ForbiddenError)) throw error;
        allowed = false;
      }
      scopes.set(scope, allowed);
    }
    if (allowed) result.push(doc);
  }
  return result;
}

/**
 * Xung đột với Word có thể thuộc tài liệu chưa có dòng `doc_repo_files` (nhà tắt đồng bộ, chưa đẩy lần nào): đường dẫn
 * lấy theo cách lô đẩy sẽ đặt.
 */
async function pathOf(tx: Tx, file: FileRow | null, doc: DocSummary): Promise<string> {
  if (file) return file.repoPath;
  return (await docLocation(tx, doc))?.path ?? `${doc.key}.md`;
}

function view(row: ConflictRow, repoPath: string, doc: DocSummary): DocConflict {
  return docConflict.parse({
    ...row,
    key: doc.key,
    title: doc.title,
    repoPath,
    hubVersion: row.state === "open" ? doc.version : row.hubVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export async function listConflicts(
  tx: Tx,
  principal: Principal,
  input: z.input<typeof listInput>,
): Promise<{ items: DocConflict[]; nextCursor: string | null }> {
  const data = listInput.parse(input);
  if (data.cursor !== undefined && !z.uuid().safeParse(data.cursor).success)
    throw new BadRequestError("DOCSYNC_INVALID_CURSOR", "Con trỏ danh sách xung đột không hợp lệ.");
  const visible = await managedDocs(tx, principal);
  if (!visible.length) return { items: [], nextCursor: null };
  const byId = new Map(visible.map((doc) => [doc.id, doc]));
  // Cursor theo khoá ổn định để việc giải quyết không làm trượt trang.
  const rows = await tx
    .select({ conflict: docConflicts, file: docRepoFiles })
    .from(docConflicts)
    .leftJoin(
      docRepoFiles,
      and(eq(docRepoFiles.docId, docConflicts.docId), eq(docRepoFiles.homeId, docConflicts.homeId)),
    )
    .where(
      and(
        inArray(docConflicts.docId, [...byId.keys()]),
        eq(docConflicts.state, data.state),
        data.homeId ? eq(docConflicts.homeId, data.homeId) : undefined,
        data.cursor ? gt(docConflicts.id, data.cursor) : undefined,
      ),
    )
    .orderBy(asc(docConflicts.id))
    .limit(data.limit + 1);
  const items: DocConflict[] = [];
  for (const { conflict, file } of rows.slice(0, data.limit)) {
    const doc = byId.get(conflict.docId);
    if (!doc) throw notFound();
    items.push(view(conflict, await pathOf(tx, file, doc), doc));
  }
  return { items, nextCursor: rows.length > data.limit ? (items.at(-1)?.id ?? null) : null };
}

export async function getConflict(tx: Tx, principal: Principal, id: string): Promise<DocConflictDetail> {
  const [row] = await tx.select().from(docConflicts).where(eq(docConflicts.id, id));
  if (!row) throw notFound();
  const doc = (await managedDocs(tx, principal)).find((doc) => doc.id === row.docId);
  if (!doc) throw notFound();
  const [file] = await tx
    .select()
    .from(docRepoFiles)
    .where(and(eq(docRepoFiles.docId, row.docId), eq(docRepoFiles.homeId, row.homeId)));
  if (!file && row.origin !== "word") throw notFound();
  const hubVersion = row.state === "open" ? doc.version : row.hubVersion;
  // Gốc của xung đột với Word là Markdown lần nhập trước, không phải một phiên bản hub.
  const base = row.baseContent ?? (await getDoc(tx, principal, { key: doc.key, version: row.baseVersion })).content;
  const hub = await getDoc(tx, principal, { key: doc.key, version: hubVersion });
  return {
    ...view(row, await pathOf(tx, file ?? null, doc), doc),
    baseContent: base,
    hubContent: hub.content,
    repoContent: row.repoContent,
    merge: mergeBlocks(base, hub.content, row.repoContent),
  };
}

/** Bản người giải quyết tự sửa có chuỗi giống bí mật thì phải xác nhận, và lần xác nhận được ghi audit. */
async function checkManualSecrets(
  tx: Tx,
  userId: string,
  key: string,
  data: Extract<DocConflictResolveInput, { choice: "manual" }>,
): Promise<void> {
  const findings = scanSecrets(data.content);
  if (findings.length && !data.acknowledgeSecrets) throw new ConflictSecretError(findings);
  if (findings.length)
    await recordAudit(tx, {
      action: "doc.secrets.acknowledge",
      actorUserId: userId,
      targetType: "doc_key",
      targetId: key,
      data: { key, contentHash: docContentHash(data.content), findings },
    });
}

/**
 * Xung đột với Word (spec 019 FR-024): bên kia là bản Word chưa nằm trong commit nào, nên không đụng tới trạng thái
 * đồng bộ repo của file. Giữ bản hub thì không tạo phiên bản; lấy bản Word hay bản tự sửa thì lưu rồi để lô đẩy ghi
 * lên repo như lần lưu thường, và dọn ảnh bản Word đã bỏ.
 */
async function resolveWordConflict(
  tx: Tx,
  principal: Extract<Principal, { kind: "user" }>,
  data: DocConflictResolveInput,
  conflict: ConflictRow,
  doc: DocSummary,
  file: FileRow | null,
  queuePush: QueuePush,
): Promise<{ key: string; version: number }> {
  const current = await getDoc(tx, principal, { key: doc.key });
  if (current.version !== data.baseVersion)
    throw new ConflictError("VERSION_CONFLICT", "Tài liệu vừa đổi. Tải bản mới nhất trước khi giải quyết.");
  let version = current.version;
  let secretFlag = false;
  if (data.choice !== "hub") {
    if (data.choice === "manual") await checkManualSecrets(tx, principal.userId, doc.key, data);
    const saved = await saveDocFromSync(tx, {
      key: doc.key,
      scope: doc.scope,
      content: data.choice === "manual" ? data.content : conflict.repoContent,
      baseVersion: data.baseVersion,
      source: data.choice === "manual" ? "merge" : "word",
      repoCommit: null,
      message: "Giải quyết xung đột cập nhật từ Word.",
      secretsAcknowledged: data.choice === "manual" && data.acknowledgeSecrets === true,
    });
    version = saved.version;
    secretFlag = saved.secretFlag;
    // Như lần giải quyết xung đột với repo: bản có bí mật chưa xác nhận không được đẩy.
    if (secretFlag && file)
      await tx
        .update(docRepoFiles)
        .set({ state: "blocked_secret", updatedAt: new Date() })
        .where(eq(docRepoFiles.id, file.id));
    await markOrphanAssets(tx, conflict.homeId);
  }
  await tx
    .update(docConflicts)
    .set({
      state: "resolved",
      resolution: data.choice,
      resolvedBy: principal.userId,
      resolvedVersion: version,
      hubVersion: current.version,
      updatedAt: new Date(),
    })
    .where(eq(docConflicts.id, conflict.id));
  await recordAudit(tx, {
    action: "doc.conflict_resolve",
    actorUserId: principal.userId,
    targetType: "doc",
    targetId: doc.id,
    data: {
      key: doc.key,
      homeId: conflict.homeId,
      conflictId: conflict.id,
      origin: "word",
      choice: data.choice,
      version,
    },
  });
  if (data.choice !== "hub" && !secretFlag) await queuePush(tx, { orgId: conflict.orgId, homeId: conflict.homeId });
  return { key: doc.key, version };
}

export async function resolveConflict(
  tx: Tx,
  principal: Principal,
  input: DocConflictResolveInput,
  queuePush: QueuePush,
): Promise<{ key: string; version: number }> {
  const data = docConflictResolveInput.parse(input);
  // Khoá xung đột trước khi đọc bản repo: hai lần bấm giải quyết không được tạo hai phiên bản.
  const [conflict] = await tx
    .select()
    .from(docConflicts)
    .where(or(eq(docConflicts.id, data.id), and(eq(docConflicts.docId, data.id), eq(docConflicts.state, "open"))))
    .for("update");
  // Cây đã có docId; dùng chính id đó cho quyết định về file bị xoá, không cần mở rộng hợp đồng API.
  const docId = conflict?.docId ?? data.id;
  const doc = (await listDocs(tx, principal, {})).find((doc) => doc.id === docId);
  if (!doc) throw notFound();
  if (principal.kind !== "user")
    throw new ForbiddenError("RUN_NOT_ALLOWED", "Agent không được giải quyết xung đột tài liệu.");
  await assertCanManageScope(tx, principal.userId, doc.scope);
  if (conflict?.state === "resolved")
    throw new ConflictError("DOCSYNC_CONFLICT_RESOLVED", "Xung đột đã được giải quyết. Tải lại tài liệu.");
  if (doc.version !== data.baseVersion)
    throw new ConflictError(
      "VERSION_CONFLICT",
      `Tài liệu đã ở phiên bản ${doc.version}. Tải bản mới nhất trước khi giải quyết.`,
    );
  const [file] = await tx.select().from(docRepoFiles).where(eq(docRepoFiles.docId, docId)).for("update");
  if (conflict?.origin === "word")
    return resolveWordConflict(tx, principal, data, conflict, doc, file ?? null, queuePush);
  if (!file || (conflict && file.homeId !== conflict.homeId)) throw notFound();
  const deleted = file.state === "deleted_in_repo";
  if (!conflict && !deleted) throw notFound();
  if (deleted && data.choice === "manual")
    throw new BadRequestError("DOCSYNC_DELETED_CHOICE", "Chọn lưu trữ tài liệu hoặc ghi lại vào repo.");

  const current = await getDoc(tx, principal, { key: doc.key });
  if (current.version !== data.baseVersion)
    throw new ConflictError("VERSION_CONFLICT", "Tài liệu vừa đổi. Tải bản mới nhất trước khi giải quyết.");
  const repoCommit = deleted ? null : (conflict?.repoCommit ?? null);
  let version = current.version;
  let secretFlag = false;
  if (deleted && data.choice === "repo") {
    await archiveDoc(tx, principal, { key: doc.key, baseVersion: data.baseVersion });
  } else {
    const content =
      data.choice === "manual"
        ? data.content
        : data.choice === "repo" && conflict
          ? conflict.repoContent
          : current.content;
    if (data.choice === "manual") await checkManualSecrets(tx, principal.userId, doc.key, data);
    const saved = await saveDocFromSync(tx, {
      key: doc.key,
      scope: doc.scope,
      content,
      baseVersion: data.baseVersion,
      source: "merge",
      repoCommit,
      message: deleted ? "Ghi lại tài liệu đã xoá trên repo." : "Giải quyết xung đột đồng bộ tài liệu.",
      secretsAcknowledged: data.choice === "manual" && data.acknowledgeSecrets === true,
    });
    version = saved.version;
    secretFlag = saved.secretFlag;
  }
  const now = new Date();
  const repoHash =
    conflict && !deleted
      ? contentHash(fromLf(conflict.repoContent, file.eol === "crlf" ? "crlf" : "lf", file.bom))
      : null;
  await tx
    .update(docRepoFiles)
    .set({
      state: deleted && data.choice === "repo" ? "synced" : secretFlag ? "blocked_secret" : "pending",
      syncedHash: repoHash,
      repoHash,
      syncedCommit: repoCommit,
      ...(deleted && data.choice === "repo" ? { syncedVersion: version } : {}),
      error: null,
      updatedAt: now,
    })
    .where(eq(docRepoFiles.id, file.id));
  if (conflict)
    await tx
      .update(docConflicts)
      .set({
        state: "resolved",
        resolution: data.choice,
        resolvedBy: principal.userId,
        resolvedVersion: version,
        hubVersion: current.version,
        updatedAt: now,
      })
      .where(eq(docConflicts.id, conflict.id));
  await recordAudit(tx, {
    action: deleted ? "doc.repo_deletion_resolve" : "doc.conflict_resolve",
    actorUserId: principal.userId,
    targetType: "doc",
    targetId: docId,
    data: { key: doc.key, homeId: file.homeId, conflictId: conflict?.id ?? null, choice: data.choice, version },
  });
  if (!secretFlag && !(deleted && data.choice === "repo"))
    await queuePush(tx, { orgId: file.orgId, homeId: file.homeId });
  return { key: doc.key, version };
}

export async function registerConflicts(_jobs: Jobs, _deps: DocSyncDeps): Promise<void> {}
