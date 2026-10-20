import {
  WORD_IMPORT_ERRORS,
  type WordImport,
  type WordImportCommitInput,
  type WordImportErrorCode,
  type WordImportFile,
  type WordImportGetOutput,
  type WordImportWarning,
} from "@xdev-hive/contracts";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { recordAudit } from "../../audit/index.ts";
import { authUser } from "../../identity/index.ts";
import {
  authorize,
  DocSecretError,
  docScope,
  type Principal,
  type Reader,
  readerFor,
  saveDoc,
} from "../../knowledge/index.ts";
import {
  ConflictError,
  createPostgresBlobStore,
  ForbiddenError,
  NotFoundError,
  type Tx,
} from "../../platform/index.ts";
import { isLfsPath, parseGitattributes } from "../content.ts";
import type { HomeRow } from "../homes.ts";
import { keyFromPath, type PathHome } from "../paths.ts";
import { pathHomeOf, projectKeyOf, queueHomePush } from "../push.ts";
import type { DocSyncDeps } from "../routes/deps.ts";
import {
  docAssets,
  docHomes,
  docRepoFiles,
  docWordImportFiles,
  docWordImports,
  type WordImportCountsRow,
} from "../schema.ts";
import { frontMatter, relinkImages } from "./postprocess.ts";
import { stageProposal } from "./staging.ts";
import type { WordImportFileRow, WordImportRow } from "./tools.ts";
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

/** Lượt nhập kèm nhà và cách đọc đường dẫn của nhà, đọc một lần cho cả lượt. */
export interface WordTarget {
  imp: WordImportRow;
  home: HomeRow;
  pathHome: PathHome;
}

export async function loadWordTarget(tx: Tx, importId: string, lock = false): Promise<WordTarget> {
  const query = tx.select().from(docWordImports).where(eq(docWordImports.id, importId));
  // Khoá lượt để hai lần bấm "Tạo" liền nhau không cùng tạo một file.
  const [imp] = lock ? await query.for("update") : await query;
  if (!imp) throw new NotFoundError("WORD_IMPORT_NOT_FOUND", "Không tìm thấy lượt nhập Word.");
  const [home] = await tx.select().from(docHomes).where(eq(docHomes.id, imp.homeId));
  if (!home) throw new NotFoundError("WORD_IMPORT_NOT_FOUND", "Không tìm thấy lượt nhập Word.");
  const pathHome = { ...pathHomeOf(home, await projectKeyOf(tx, home)), include: home.include, exclude: home.exclude };
  return { imp, home, pathHome };
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

/** Đường dẫn người nhập đã sửa, không thì đường dẫn đề xuất. */
const pathOf = (file: WordImportFileRow): string | null => file.pathOverride ?? file.proposedPath;

/** Key suy từ đường dẫn; null khi đường dẫn nằm ngoài nhà hoặc bị loại trừ. */
export function keyOfPath(target: WordTarget, path: string | null): string | null {
  if (!path) return null;
  const root = target.home.root.replace(/\/+$/, "");
  // Nhà dự án nhận cả đường dẫn ngoài gốc (`keyFromPath`), nhưng tài liệu nhập phải nằm trong thư mục tài liệu.
  if (root && !path.startsWith(`${root}/`)) return null;
  try {
    return keyFromPath(path, target.pathHome);
  } catch {
    return null;
  }
}

const FRONT_MATTER = /^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** Bỏ front matter ở đầu Markdown (như `countStats` của postprocess.ts) và các dòng trống ngay sau nó. */
export function stripFrontMatter(markdown: string): string {
  return markdown.replace(FRONT_MATTER, "").replace(/^(?:[ \t]*\r?\n)+/, "");
}

const titleOf = (file: WordImportFileRow): string =>
  file.titleOverride ?? file.proposedTitle ?? file.fileName.replace(/\.[^.]+$/, "");

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

/** Key hoặc đường dẫn đã có tài liệu (FR-019). So đường dẫn không phân biệt hoa thường: repo trên Windows và macOS coi là một. */
async function taken(tx: Tx, home: HomeRow, key: string, path: string): Promise<boolean> {
  const { rows } = await tx.execute(sql`
    select 1 from hive.docs where key = ${key}
    union all
    select 1 from hive.doc_repo_files where home_id = ${home.id} and lower(repo_path) = lower(${path})
    limit 1`);
  return rows.length > 0;
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

async function canManage(tx: Tx, reader: Reader, key: string): Promise<boolean> {
  try {
    await authorize(tx, reader, await docScope(tx, reader, key), "manage");
    return true;
  } catch (error) {
    if (error instanceof ForbiddenError) return false;
    throw error;
  }
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

const COUNT_KEYS: Record<string, keyof WordImportCountsRow> = {
  queued: "queued",
  converting: "converting",
  ready: "ready",
  skipped: "skipped",
  blocked_secret: "blockedSecret",
  failed: "failed",
  proposed: "proposed",
  cancelled: "cancelled",
  done: "done",
};

/** Đếm lại file theo trạng thái; không còn file nào chờ tạo thì lượt xong. */
export async function refreshWordImport(tx: Tx, importId: string): Promise<void> {
  const rows = await tx
    .select({ state: docWordImportFiles.state, excluded: docWordImportFiles.excluded, n: count() })
    .from(docWordImportFiles)
    .where(eq(docWordImportFiles.importId, importId))
    .groupBy(docWordImportFiles.state, docWordImportFiles.excluded);
  const counts: WordImportCountsRow = {
    queued: 0,
    converting: 0,
    ready: 0,
    skipped: 0,
    blockedSecret: 0,
    failed: 0,
    proposed: 0,
    cancelled: 0,
    done: 0,
  };
  let waiting = 0;
  for (const r of rows) {
    const key = COUNT_KEYS[r.state];
    if (key) counts[key] += r.n;
    if (!r.excluded && ["queued", "converting", "ready", "blocked_secret"].includes(r.state)) waiting += r.n;
  }
  const [imp] = await tx.select().from(docWordImports).where(eq(docWordImports.id, importId));
  if (!imp) return;
  const finished = waiting === 0 && !["uploading", "failed", "cancelled"].includes(imp.state);
  await tx
    .update(docWordImports)
    .set({ counts, ...(finished ? { state: "done" } : {}), updatedAt: new Date() })
    .where(eq(docWordImports.id, importId));
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
  await refreshWordImport(tx, target.imp.id);
  return wordImportView(tx, principal, target.imp.id);
}

// ---- Dạng trả về ---------------------------------------------------------------------------------------------------

/** Key và đường dẫn hiện của file: lượt tạo suy từ đường dẫn, lượt cập nhật và gắn lấy theo tài liệu đích. */
interface FilePlace {
  path: string | null;
  key: string | null;
  exists: boolean;
}

export function wordFileView(file: WordImportFileRow, place: FilePlace): WordImportFile {
  return {
    id: file.id,
    importId: file.importId,
    relativeDir: file.relativeDir,
    fileName: file.fileName,
    format: file.format as WordImportFile["format"],
    size: file.size,
    sha256: file.sha256,
    versionLabel: file.versionLabel,
    proposedPath: file.proposedPath,
    proposedTitle: file.proposedTitle,
    path: place.path,
    title: file.titleOverride ?? file.proposedTitle,
    key: place.key,
    exists: place.exists,
    keepFront: file.keepFront,
    excluded: file.excluded,
    state: file.state as WordImportFile["state"],
    stats: file.stats ?? null,
    warnings: file.warnings as WordImportWarning[],
    findings: file.findings as WordImportFile["findings"],
    error: (file.error as WordImportFile["error"]) ?? null,
    linkMatches: file.linkMatches,
    docId: file.docId,
    docVersion: file.docVersion,
    proposalId: file.proposalId,
    createdAt: file.createdAt.toISOString(),
    updatedAt: file.updatedAt.toISOString(),
  };
}

async function docKeyOf(tx: Tx, docId: string | null): Promise<string | null> {
  if (!docId) return null;
  const { rows } = await tx.execute<{ key: string }>(sql`select key from hive.docs where id = ${docId}`);
  return rows[0]?.key ?? null;
}

/** Vị trí của các file trong lượt; một truy vấn cho mọi key thay vì một truy vấn mỗi file. */
export async function filePlaces(
  tx: Tx,
  target: WordTarget,
  files: WordImportFileRow[],
): Promise<Map<string, FilePlace>> {
  const docKey = await docKeyOf(tx, target.imp.updateDocId);
  const keys = new Map(
    files.map((f) => [f.id, target.imp.mode === "create" ? keyOfPath(target, pathOf(f)) : docKey] as const),
  );
  const wanted = [...new Set([...keys.values()].filter((k): k is string => k !== null))];
  const existing = new Set<string>();
  if (wanted.length) {
    const { rows } = await tx.execute<{ key: string }>(
      sql`select key from hive.docs where key in (${sql.join(
        wanted.map((k) => sql`${k}`),
        sql`, `,
      )})`,
    );
    for (const r of rows) existing.add(r.key);
  }
  return new Map(
    files.map((f) => {
      const key = keys.get(f.id) ?? null;
      return [f.id, { path: pathOf(f), key, exists: key !== null && existing.has(key) }];
    }),
  );
}

/** Quyền ở phạm vi đích: `manage` thì giao diện hiện "Tạo", chỉ `propose` thì "Gửi duyệt" (Q2). */
async function accessOf(tx: Tx, principal: Principal, target: WordTarget): Promise<WordImportGetOutput["access"]> {
  const { imp } = target;
  const key =
    imp.mode === "create"
      ? keyOfPath(target, `${imp.targetDir ? `${imp.targetDir.replace(/\/+$/, "")}/` : ""}word-import.md`)
      : await docKeyOf(tx, imp.updateDocId);
  if (!key) return "propose";
  try {
    return (await canManage(tx, await readerFor(tx, principal), key)) ? "manage" : "propose";
  } catch {
    return "propose";
  }
}

export async function wordImportOf(tx: Tx, imp: WordImportRow): Promise<WordImport> {
  const [creator] = await tx.select({ name: authUser.name }).from(authUser).where(eq(authUser.id, imp.createdBy));
  return {
    id: imp.id,
    homeId: imp.homeId,
    targetDir: imp.targetDir,
    mode: imp.mode as WordImport["mode"],
    docKey: await docKeyOf(tx, imp.updateDocId),
    confidential: imp.confidential,
    state: imp.state as WordImport["state"],
    counts: imp.counts,
    createdBy: { id: imp.createdBy, name: creator?.name ?? null },
    createdAt: imp.createdAt.toISOString(),
    updatedAt: imp.updatedAt.toISOString(),
  };
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
    files: files.map((f) => wordFileView(f, places.get(f.id) ?? { path: null, key: null, exists: false })),
    access: await accessOf(tx, principal, target),
  };
}
