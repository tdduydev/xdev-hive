import { WORD_IMPORT_ERRORS } from "@xdev-hive/contracts";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { recordAudit } from "../../audit/index.ts";
import {
  assertDocSecrets,
  authorize,
  docScope,
  type Principal,
  type ProposalApprovedHandler,
  proposalsByOrigin,
  proposeDoc,
  readerFor,
} from "../../knowledge/index.ts";
import { ConflictError, ForbiddenError, type Jobs, NotFoundError, type Tx, withTenant } from "../../platform/index.ts";
import { queueHomePush } from "../push.ts";
import { DOCSYNC_WORD_STAGING_QUEUE } from "../queues.ts";
import type { DocSyncDeps } from "../routes/deps.ts";
import { docWordImportFiles } from "../schema.ts";
import { attachImages, FileFailure, fileError, pinPath } from "./attach.ts";
import {
  canManage,
  keyOfPath,
  loadWordTarget,
  pathOf,
  refreshWordImportCounts,
  taken,
  titleOf,
  type WordTarget,
} from "./shared.ts";
import { type WordImportFileRow, wordTools } from "./tools.ts";

// Người chỉ có `propose` tạo tài liệu từ Word (P2, FR-027, Q14, plan.md mục 9): mỗi file một đề xuất. File và ảnh vẫn
// nằm ở `doc_word_import_files` (chỗ giữ tạm sẵn có); chỉ khi duyệt mới ghi đường dẫn, ảnh và xếp lô đẩy.

export const DOCSYNC_WORD_STAGING_CRON = "23 * * * *";
const SWEEP_BATCH = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

type StagedPatch = Partial<Pick<WordImportFileRow, "state" | "error" | "findings" | "proposalId">>;

export const needsManage = () =>
  new ForbiddenError("WORD_IMPORT_NEEDS_MANAGE", WORD_IMPORT_ERRORS.WORD_IMPORT_NEEDS_MANAGE.message);

/**
 * Gửi một file thành đề xuất tài liệu mới, `origin {kind: "word", importFileId}`. Bí mật qua `assertDocSecrets` như
 * bản nháp: chỉ người `manage` xác nhận được, nên người chỉ có `propose` phải bỏ chuỗi đó khỏi file Word.
 */
export async function stageProposal(
  tx: Tx,
  principal: Principal,
  target: WordTarget,
  file: WordImportFileRow,
  plan: { key: string; path: string; content: string },
  acknowledgeSecrets: boolean,
): Promise<StagedPatch> {
  const reader = await readerFor(tx, principal);
  const scope = await docScope(tx, reader, plan.key);
  // Không có cả `propose` thì như P1 (Q2): báo cả lượt, không ghi lỗi vào từng file.
  await authorize(tx, reader, scope, "propose").catch((error) => {
    throw error instanceof ForbiddenError ? needsManage() : error;
  });
  if (await taken(tx, target.home, plan.key, plan.path)) throw new FileFailure(fileError("WORD_IMPORT_EXISTS"));
  try {
    await assertDocSecrets(tx, principal, { reader, scope, key: plan.key, content: plan.content }, acknowledgeSecrets);
  } catch (error) {
    if (!(error instanceof ForbiddenError)) throw error;
    throw new FileFailure(
      fileError(
        "WORD_IMPORT_NEEDS_MANAGE",
        "Chỉ người quản lý tài liệu mới xác nhận được chuỗi giống bí mật. Xoá chuỗi đó khỏi file Word rồi tải lại, hoặc nhờ quản trị đội nhập hộ.",
      ),
    );
  }
  const proposal = await proposeDoc(
    tx,
    principal,
    {
      key: plan.key,
      baseVersion: 0,
      title: titleOf(file),
      content: plan.content,
      reason: `Nhập từ file Word ${file.fileName}`,
    },
    { origin: { kind: "word", importFileId: file.id } },
  );
  return { state: "proposed", error: null, findings: [], proposalId: proposal.id };
}

/**
 * Người duyệt (quản lý ở phạm vi của tài liệu đích) xem được ảnh giữ tạm của file đang chờ duyệt, kể cả khi không
 * thấy lượt nhập: người nhập có thể đổi đường dẫn sang phạm vi khác với thư mục đích của lượt.
 */
export async function canReviewStaged(tx: Tx, principal: Principal, file: WordImportFileRow): Promise<boolean> {
  if (file.state !== "proposed" || !file.proposalId) return false;
  const key = keyOfPath(await loadWordTarget(tx, file.importId), pathOf(file));
  if (!key) return false;
  try {
    return await canManage(tx, await readerFor(tx, principal), key);
  } catch (error) {
    if (error instanceof NotFoundError) return false;
    throw error;
  }
}

/**
 * Hook duyệt đề xuất (`provideProposalApproved`): bước 4–8 của plan.md mục 6 cho tài liệu vừa lưu, trong giao dịch
 * duyệt. Lỗi thì giao dịch duyệt rollback và đề xuất vẫn chờ.
 */
export function wordProposalApproved(jobs: Jobs | undefined): ProposalApprovedHandler {
  return async (tx, proposal, savedDoc) => {
    if (proposal.origin?.kind !== "word") return;
    const [file] = await tx
      .select()
      .from(docWordImportFiles)
      .where(eq(docWordImportFiles.id, proposal.origin.importFileId))
      .for("update");
    // Cron đã dọn (bị từ chối trước đó hoặc chờ quá hạn): ảnh không còn, duyệt sẽ ra tài liệu thiếu ảnh.
    if (file?.state !== "proposed")
      throw new ConflictError(
        "WORD_IMPORT_STAGING_GONE",
        "Bản nhập Word của đề xuất đã hết hạn giữ tạm và đã được dọn. Từ chối đề xuất này và nhờ người nhập tải lại file Word.",
      );
    const target = await loadWordTarget(tx, file.importId);
    const path = pathOf(file);
    try {
      // Đường dẫn giữ hoa thường như người nhập chọn; lệch key thì để hook lưu gắn theo key.
      if (path && keyOfPath(target, path) === savedDoc.key) await pinPath(tx, target.home, savedDoc.id, path);
      await attachImages(tx, target.home, file.images, savedDoc.id, savedDoc.key);
    } catch (error) {
      if (error instanceof FileFailure) throw new ConflictError(error.error.code, error.error.message);
      throw error;
    }
    await recordAudit(tx, {
      action: "docs.word_import",
      targetType: "doc",
      targetId: savedDoc.id,
      data: {
        importId: file.importId,
        fileId: file.id,
        docKey: savedDoc.key,
        sha256: file.sha256,
        proposalId: proposal.id,
      },
    });
    await queueHomePush(tx, jobs, target.home);
    await tx
      .update(docWordImportFiles)
      .set({ state: "done", error: null, docId: savedDoc.id, docVersion: savedDoc.version, updatedAt: new Date() })
      .where(eq(docWordImportFiles.id, file.id));
    await refreshWordImportCounts(tx, file.importId, "commit");
  };
}

// ---- Dọn giữ tạm -------------------------------------------------------------------------------------------------

/**
 * Bỏ file Word gốc và ảnh giữ tạm của đề xuất bị từ chối hoặc chờ quá `stagingDays`; GC của BlobStore xoá blob khi
 * không còn ai trỏ tới (`wordImportBlobRefs`). Markdown cũng bỏ (US4 kịch bản 3).
 */
export async function sweepWordStaging(tx: Tx, stagingDays: number, now = new Date()): Promise<number> {
  const files = await tx
    .select({ id: docWordImportFiles.id, importId: docWordImportFiles.importId })
    .from(docWordImportFiles)
    .where(and(eq(docWordImportFiles.state, "proposed"), isNotNull(docWordImportFiles.proposalId)))
    .limit(SWEEP_BATCH);
  if (!files.length) return 0;
  const proposals = await proposalsByOrigin(tx, { kind: "word", importFileIds: files.map((f) => f.id) });
  // Một file có thể có nhiều đề xuất nếu gửi lại; đề xuất mới nhất quyết định (danh sách đã xếp mới trước).
  const latest = new Map<string, (typeof proposals)[number]>();
  for (const p of proposals) if (!latest.has(p.importFileId)) latest.set(p.importFileId, p);
  const deadline = now.getTime() - stagingDays * DAY_MS;
  const stale = files.filter((f) => {
    const p = latest.get(f.id);
    if (!p) return true;
    if (p.status === "rejected") return true;
    return p.status === "pending" && p.createdAt.getTime() < deadline;
  });
  for (const f of stale)
    await tx
      .update(docWordImportFiles)
      .set({ state: "cancelled", blobId: null, markdown: null, images: [], updatedAt: new Date() })
      .where(eq(docWordImportFiles.id, f.id));
  for (const importId of new Set(stale.map((f) => f.importId))) await refreshWordImportCounts(tx, importId, "commit");
  return stale.length;
}

/** Cron dọn file và ảnh giữ tạm của đề xuất bị từ chối hoặc quá `HIVE_DOC_WORD_STAGING_DAYS`. */
export async function registerWordStaging(jobs: Jobs, deps: DocSyncDeps): Promise<void> {
  const { pool } = deps;
  const tools = wordTools();
  // Hub không bật nhập Word thì không có file giữ tạm nào.
  if (!pool || !tools) return;
  const days = tools.config.stagingDays;
  await jobs.work(DOCSYNC_WORD_STAGING_QUEUE, async () => {
    const orgs = await withTenant(pool, {}, async (tx) => {
      const { rows } = await tx.execute<{ org_id: string }>(sql`select org_id from hive.docsync_active_orgs()`);
      return rows.map((r) => r.org_id);
    });
    for (const orgId of orgs) await withTenant(pool, { orgId }, (tx) => sweepWordStaging(tx, days));
  });
  await jobs.schedule(DOCSYNC_WORD_STAGING_QUEUE, DOCSYNC_WORD_STAGING_CRON, { scan: true });
}
