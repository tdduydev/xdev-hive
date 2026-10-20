import {
  WORD_IMPORT_ERRORS,
  type WordImportCommitInput,
  type WordImportErrorCode,
  type WordImportGetOutput,
} from "@xdev-hive/contracts";
import { and, asc, eq, sql } from "drizzle-orm";
import { recordAudit } from "../../audit/index.ts";
import { DocSecretError, type Principal, readerFor, saveDoc } from "../../knowledge/index.ts";
import { ConflictError, createPostgresBlobStore, NotFoundError, type Tx } from "../../platform/index.ts";
import { isLfsPath, parseGitattributes } from "../content.ts";
import type { HomeRow } from "../homes.ts";
import { queueHomePush } from "../push.ts";
import type { DocSyncDeps } from "../routes/deps.ts";
import { docAssets, docRepoFiles, docWordImportFiles } from "../schema.ts";
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

type FileError = NonNullable<WordImportFileRow["error"]>;
type FilePatch = Partial<Pick<WordImportFileRow, "state" | "error" | "findings" | "docId" | "docVersion">>;

export const fileError = (code: WordImportErrorCode, message?: string): FileError => ({
  code,
  message: message ?? WORD_IMPORT_ERRORS[code].message,
});

/** Lỗi của riêng một file: ghi vào file rồi đi tiếp, không làm hỏng cả lượt. */
class FileFailure extends Error {
  readonly error: FileError;

  constructor(error: FileError) {
    super(error.message);
    this.error = error;
  }
}

/** Như `homeDir` của assets.ts (chưa export): ảnh của nhà dự án nằm ở gốc nhà, nhà tổ chức tách theo đội. */
function homeDir(home: HomeRow, key: string): string {
  const root = home.root.replace(/\/+$/, "");
  if (home.scope === "project") return root;
  const team = /^team\/([a-z0-9-]+)\//.exec(key)?.[1];
  return [root, team ? `teams/${team}` : "org"].filter(Boolean).join("/");
}

export function assetsDirOf(home: HomeRow, key: string): string {
  return [homeDir(home, key), home.assetsDir.replace(/^\/+|\/+$/g, "")].filter(Boolean).join("/");
}

const FRONT_MATTER = /^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** Bỏ front matter ở đầu Markdown (như `countStats` của postprocess.ts) và các dòng trống ngay sau nó. */
export function stripFrontMatter(markdown: string): string {
  return markdown.replace(FRONT_MATTER, "").replace(/^(?:[ \t]*\r?\n)+/, "");
}

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

/**
 * Ghi đúng đường dẫn đã chọn. Hook lưu của docsync đã gắn tài liệu vào đường dẫn suy từ key (chữ thường), nên sửa
 * dòng đó thay vì thêm dòng thứ hai. Nhà tắt đồng bộ thì hook không gắn, ở đây cũng không.
 */
async function pinPath(tx: Tx, home: HomeRow, docId: string, path: string): Promise<void> {
  if (home.mode === "off") return;
  const [row] = await tx.select().from(docRepoFiles).where(eq(docRepoFiles.docId, docId));
  if (row) {
    await tx
      .update(docRepoFiles)
      .set({ repoPath: path, state: "pending", updatedAt: new Date() })
      .where(eq(docRepoFiles.id, row.id));
    return;
  }
  await tx.insert(docRepoFiles).values({ orgId: home.orgId, homeId: home.id, docId, repoPath: path, state: "pending" });
}

const blobStore = createPostgresBlobStore();

/** Ảnh vào thư mục ảnh của nhà, trỏ tới blob đã có từ lúc chuyển; lô đẩy kế tiếp ghi chúng cùng tài liệu. */
async function attachImages(tx: Tx, target: WordTarget, file: WordImportFileRow, docId: string, key: string) {
  const { home } = target;
  const dir = assetsDirOf(home, key);
  const rules = parseGitattributes(home.lfsPatterns.map((p) => `${p} filter=lfs`).join("\n"));
  for (const image of file.images) {
    const repoPath = `${dir}/${image.name}`;
    const blob = await blobStore.stat(tx, home.orgId, image.blobId);
    if (!blob)
      throw new FileFailure(
        fileError(
          "WORD_IMPORT_CONVERT_FAILED",
          "Ảnh tách từ file Word không còn trong kho file. Tải file Word lên lại.",
        ),
      );
    const [existing] = await tx
      .select()
      .from(docAssets)
      .where(and(eq(docAssets.homeId, home.id), eq(docAssets.repoPath, repoPath)))
      .for("update");
    if (existing) {
      if (existing.sha256 !== blob.sha256)
        throw new FileFailure(
          fileError(
            "WORD_IMPORT_EXISTS",
            `Thư mục ảnh đã có ${image.name} khác nội dung. Đổi file ảnh trong repo rồi tạo lại.`,
          ),
        );
      // Ảnh đang chờ xoá vì không còn ai trỏ tới thì giữ lại: tài liệu này trỏ tới nó.
      if (existing.state === "pending_delete")
        await tx
          .update(docAssets)
          .set({ state: "available", updatedAt: new Date() })
          .where(eq(docAssets.id, existing.id));
      continue;
    }
    await tx
      .insert(docAssets)
      .values({
        orgId: home.orgId,
        homeId: home.id,
        repoPath,
        blobId: blob.id,
        mediaType: blob.mediaType,
        size: blob.size,
        sha256: blob.sha256,
        lfs: isLfsPath(repoPath, rules),
        state: "pending_push",
        ownerDocId: docId,
      })
      .onConflictDoNothing();
  }
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
  await attachImages(tx, target, file, doc.id, plan.key);
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
    if (!(await canManage(tx, reader, plan.key))) {
      // Tới T016 thì file thành đề xuất; trước đó báo cần quyền quản lý (Q2).
      await stageProposal(tx, principal, file);
      continue;
    }
    // withTenant đã mở transaction nên dùng savepoint tay, như import.ts: một file lỗi không làm hỏng các file khác.
    await tx.execute(sql`savepoint word_commit_file`);
    try {
      patches.set(file.id, await createDoc(tx, deps, principal, target, file, plan, acknowledgeSecrets));
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
