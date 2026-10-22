import type { WordImportCommitInput, WordImportGetOutput } from "@xdev-hive/contracts";
import { asc, eq, sql } from "drizzle-orm";
import { recordAudit } from "../../audit/index.ts";
import { DocSecretError, type Principal, readerFor, saveDoc } from "../../knowledge/index.ts";
import { ConflictError, NotFoundError, type Tx } from "../../platform/index.ts";
import { queueHomePush } from "../push.ts";
import type { DocSyncDeps } from "../routes/deps.ts";
import { docWordImportFiles } from "../schema.ts";
import { assetsDirOf, attachImages, FileFailure, fileError, pinPath, stripFrontMatter } from "./attach.ts";
import { frontMatter, relinkImages } from "./postprocess.ts";
import {
  canManage,
  filePlaces,
  keyOfPath,
  loadWordTarget,
  NO_PLACE,
  pathOf,
  refreshWordImportCounts,
  scopeKeyOf,
  taken,
  titleOf,
  type WordTarget,
  wordFileView,
  wordImportOf,
} from "./shared.ts";
import { stageProposal } from "./staging.ts";
import type { WordImportFileRow } from "./tools.ts";
import { commitUpdate } from "./update.ts";

// link.ts và test vẫn import các hàm này từ đây.
export { assetsDirOf, fileError, stripFrontMatter };

type FilePatch = Partial<
  Pick<WordImportFileRow, "state" | "error" | "findings" | "docId" | "docVersion" | "proposalId">
>;

/**
 * Nội dung tài liệu: front matter theo FR-012 với tiêu đề cuối, thân với link ảnh tính theo đường dẫn cuối. Front
 * matter dựng lại ở đây vì người nhập có thể đã đổi tiêu đề sau khi chuyển.
 */
function documentContent(target: WordTarget, file: WordImportFileRow, key: string, path: string): string {
  const body = relinkImages(stripFrontMatter(file.markdown ?? ""), path, assetsDirOf(target.home, key));
  return (
    frontMatter({
      title: titleOf(file),
      file: file.fileName,
      sha256: file.sha256,
      confidential: target.imp.confidential,
    }) + body
  );
}

async function createDoc(
  tx: Tx,
  deps: DocSyncDeps,
  principal: Principal,
  target: WordTarget,
  file: WordImportFileRow,
  plan: { key: string; path: string },
  acknowledgeSecrets: boolean,
): Promise<FilePatch> {
  // Kiểm lại trong giao dịch: người khác có thể vừa tạo cùng key sau khi xem trước báo trống.
  if (await taken(tx, target.home, plan.key, plan.path)) throw new FileFailure(fileError("WORD_IMPORT_EXISTS"));
  const doc = await saveDoc(
    tx,
    principal,
    {
      key: plan.key,
      title: titleOf(file),
      content: documentContent(target, file, plan.key, plan.path),
      baseVersion: 0,
      acknowledgeSecrets,
    },
    { source: "word" },
  );
  await pinPath(tx, target.home, doc.id, plan.path);
  await attachImages(tx, target.home, file.images, doc.id, plan.key);
  await recordAudit(tx, {
    action: "docs.word_import",
    targetType: "doc",
    targetId: doc.id,
    data: { importId: target.imp.id, fileId: file.id, docKey: plan.key, sha256: file.sha256 },
  });
  await queueHomePush(tx, deps.jobs, target.home);
  return { state: "done", error: null, findings: [], docId: doc.id, docVersion: doc.version };
}

/** Lỗi nào thuộc riêng file thì đổi thành trạng thái của file; lỗi khác ném tiếp. */
function failureOf(error: unknown): FilePatch | null {
  if (error instanceof FileFailure) return { error: error.error };
  if (error instanceof DocSecretError)
    return {
      state: "blocked_secret",
      error: null,
      findings: error.findings.map((f) => ({ kind: f.kind, line: f.line })),
    };
  // saveDoc báo VERSION_CONFLICT khi key vừa bị tạo; ràng buộc một đường dẫn một tài liệu báo 23505.
  if (error instanceof ConflictError && error.code === "VERSION_CONFLICT")
    return { error: fileError("WORD_IMPORT_EXISTS") };
  const code =
    (error as { code?: unknown; cause?: { code?: unknown } }).cause?.code ?? (error as { code?: unknown }).code;
  if (code === "23505") return { error: fileError("WORD_IMPORT_EXISTS") };
  return null;
}

async function createDocs(
  tx: Tx,
  deps: DocSyncDeps,
  principal: Principal,
  target: WordTarget,
  files: WordImportFileRow[],
  acknowledgeSecrets: boolean,
): Promise<void> {
  const patches = new Map<string, FilePatch>();
  const planned: Array<{ file: WordImportFileRow; key: string; path: string }> = [];
  for (const file of files) {
    const path = pathOf(file);
    const key = keyOfPath(target, path);
    if (!path || !key) patches.set(file.id, { error: fileError("WORD_IMPORT_OUTSIDE_HOME") });
    else planned.push({ file, key, path });
  }
  // Hai file ra cùng key (khác hoa thường hay dấu) thì không file nào được tạo: chọn hộ người nhập dễ mất bản đúng.
  const byKey = Map.groupBy(planned, (p) => p.key);
  const reader = await readerFor(tx, principal);
  for (const plan of planned) {
    const { file } = plan;
    if ((byKey.get(plan.key)?.length ?? 0) > 1) {
      patches.set(file.id, { error: fileError("WORD_IMPORT_DUPLICATE_PATH") });
      continue;
    }
    // Chỉ có `propose` thì file thành đề xuất (plan.md mục 9); bước 4–8 chạy khi đề xuất được duyệt.
    const manage = await canManage(tx, reader, plan.key);
    // withTenant đã mở transaction nên dùng savepoint tay, như import.ts: một file lỗi không làm hỏng các file khác.
    await tx.execute(sql`savepoint word_commit_file`);
    try {
      const patch = manage
        ? await createDoc(tx, deps, principal, target, file, plan, acknowledgeSecrets)
        : await stageProposal(
            tx,
            principal,
            target,
            file,
            { ...plan, content: documentContent(target, file, plan.key, plan.path) },
            acknowledgeSecrets,
          );
      patches.set(file.id, patch);
      await tx.execute(sql`release savepoint word_commit_file`);
    } catch (error) {
      await tx.execute(sql`rollback to savepoint word_commit_file`);
      const patch = failureOf(error);
      if (!patch) throw error;
      patches.set(file.id, patch);
    }
  }
  for (const [id, patch] of patches)
    await tx
      .update(docWordImportFiles)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(docWordImportFiles.id, id));
}

/**
 * Tạo tài liệu từ các file `ready` của lượt (FR-017…FR-021, plan.md mục 6). Mỗi file một savepoint; trùng đường dẫn,
 * đã có tài liệu hay có bí mật chưa xác nhận thì ghi vào file đó và đi tiếp. Thiếu quyền `manage` thì đi `stageProposal`.
 */
export async function commitWordImport(
  tx: Tx,
  deps: DocSyncDeps,
  principal: Principal,
  input: WordImportCommitInput,
): Promise<WordImportGetOutput> {
  const target = await loadWordTarget(tx, input.importId, true);
  const files = await tx
    .select()
    .from(docWordImportFiles)
    .where(eq(docWordImportFiles.importId, target.imp.id))
    .orderBy(asc(docWordImportFiles.relativeDir), asc(docWordImportFiles.fileName));
  const acknowledge = input.acknowledgeSecrets === true;
  // File có bí mật chỉ đi tiếp khi người nhập đã xác nhận không phải bí mật (FR-018).
  const states = acknowledge ? ["ready", "blocked_secret"] : ["ready"];
  let chosen = files;
  if (input.fileIds) {
    const ids = new Set(input.fileIds);
    chosen = files.filter((f) => ids.has(f.id));
    if (chosen.length !== ids.size)
      throw new NotFoundError("WORD_IMPORT_FILE_NOT_FOUND", "Không tìm thấy file trong lượt nhập Word.");
  }
  chosen = chosen.filter((f) => !f.excluded && f.docId === null && states.includes(f.state));
  if (target.imp.mode === "create") await createDocs(tx, deps, principal, target, chosen, acknowledge);
  else if (target.imp.mode === "update") for (const file of chosen) await commitUpdate(tx, deps, principal, file);
  // Gắn (mode = link) không tạo phiên bản: file xong ở `prepareLink` hoặc `confirmLink`.
  await refreshWordImportCounts(tx, target.imp.id, "commit");
  return wordImportView(tx, principal, target.imp.id);
}

// ---- Dạng trả về ---------------------------------------------------------------------------------------------------

/** Quyền ở phạm vi đích: `manage` thì giao diện hiện "Tạo", chỉ `propose` thì "Gửi duyệt" (Q2). */
async function accessOf(tx: Tx, principal: Principal, target: WordTarget): Promise<WordImportGetOutput["access"]> {
  const key = await scopeKeyOf(tx, target);
  if (!key) return "propose";
  try {
    return (await canManage(tx, await readerFor(tx, principal), key)) ? "manage" : "propose";
  } catch {
    return "propose";
  }
}

export async function wordImportView(tx: Tx, principal: Principal, importId: string): Promise<WordImportGetOutput> {
  const target = await loadWordTarget(tx, importId);
  const files = await tx
    .select()
    .from(docWordImportFiles)
    .where(eq(docWordImportFiles.importId, importId))
    .orderBy(asc(docWordImportFiles.relativeDir), asc(docWordImportFiles.fileName));
  const places = await filePlaces(tx, target, files);
  return {
    import: await wordImportOf(tx, target.imp),
    files: files.map((f) => wordFileView(f, places.get(f.id) ?? NO_PLACE)),
    access: await accessOf(tx, principal, target),
  };
}
