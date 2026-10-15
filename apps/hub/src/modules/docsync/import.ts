import { createHash } from "node:crypto";
import {
  DOC_MAX_CHARS,
  type DocImport,
  type DocImportFile,
  docImport,
  type docImportCollisionResolution,
  docImportConfirmSecretInput,
  docImportFile,
  docImportScanInput,
  docImportStartInput,
  scanSecrets,
} from "@xdev-hive/contracts";
import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type pg from "pg";
import { z } from "zod";
import { recordAudit } from "../audit/index.ts";
import { loadProject } from "../catalog/index.ts";
import { assertCanManageScope, saveDocFromSync } from "../knowledge/index.ts";
import { notify } from "../notify/index.ts";
import {
  BadRequestError,
  type BlobStore,
  ConflictError,
  createPostgresBlobStore,
  type DocStorageLimits,
  type Jobs,
  loadDocStorageLimits,
  NotFoundError,
  type Tx,
  withTenant,
} from "../platform/index.ts";
import { type GitProvider, type LfsAction, lfsDownload, type RepoRef } from "../scm/index.ts";
import { detectEol, hasBom, parseLfsPointer, titleOf, toLf } from "./content.ts";
import { type HomeRow, homeById, homeProvider, requireHomeManage } from "./homes.ts";
import { DOCSYNC_EXTRACT_QUEUE, DOCSYNC_IMPORT_QUEUE, DOCSYNC_SCAN_IMPORT_QUEUE, queuePush } from "./queues.ts";
import type { DocSyncDeps } from "./routes/deps.ts";
import {
  decodeUtf8,
  EXTRACTABLE,
  errorText,
  type ImportFileRow,
  type ImportJob,
  type ImportRow,
  type RepoEntry,
  readRepoFiles,
  repoRef,
  retryLater,
  runScan,
  useArchive,
  W,
} from "./scan.ts";
import { docAssets, docExtracts, docImportFiles, docImports, docRepoFiles } from "./schema.ts";

type Actor = { userId: string; orgId: string };
type Scope = { teamId: string | null; projectId: string | null };
type Resolution = z.output<typeof docImportCollisionResolution>;
type FilePatch = Partial<Pick<ImportFileRow, "state" | "docId" | "assetId" | "error" | "secretScan" | "findings">>;

/** Mỗi lô một transaction: ngắt giữa chừng thì lô dở rollback, chạy lại chỉ còn file pending. */
export const IMPORT_BATCH_FILES = 200;
const IMPORT_BATCH_BYTES = 64 * 1024 ** 2;

const notFound = () => new NotFoundError("DOCSYNC_IMPORT_NOT_FOUND", "Không tìm thấy lần nhập tài liệu.");
const stateError = (message: string) => new ConflictError("DOCSYNC_IMPORT_STATE", message);

export function importView(row: ImportRow): DocImport {
  return docImport.parse({
    ...row,
    report: Object.keys(row.report).length ? row.report : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

const fileView = (row: ImportFileRow): DocImportFile => docImportFile.parse({ ...row, path: row.repoPath });

async function loadImport(tx: Tx, id: string, lock = false) {
  const query = tx.select().from(docImports).where(eq(docImports.id, id));
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw notFound();
  return row;
}

async function managedImport(tx: Tx, actor: Actor, id: string, lock = false) {
  const imp = await loadImport(tx, id, lock);
  const home = await homeById(tx, imp.homeId);
  await requireHomeManage(tx, actor.userId, home);
  return { imp, home };
}

type ExistingDoc = { id: string; mapped: boolean; version: number; teamId: string | null; projectId: string | null };

async function existingDoc(tx: Tx, key: string): Promise<ExistingDoc | null> {
  // Bảng docs thuộc knowledge; chỉ đọc vài cột để quyết định gắn, không ghi.
  const { rows } = await tx.execute<{
    id: string;
    mapped: boolean;
    version: number;
    team_id: string | null;
    project_id: string | null;
  }>(sql`
    select d.id, d.current_version as version, d.team_id, d.project_id,
           exists (select 1 from hive.doc_repo_files f where f.doc_id = d.id) as mapped
      from hive.docs d where d.key = ${key}`);
  const row = rows[0];
  return row
    ? { id: row.id, mapped: row.mapped, version: row.version, teamId: row.team_id, projectId: row.project_id }
    : null;
}

async function progressOf(tx: Tx, importId: string) {
  const [row] = await tx
    .select({
      done: sql<number>`(count(*) filter (where ${docImportFiles.state} not in ('pending', 'skipped')))::int`,
      total: sql<number>`(count(*) filter (where ${docImportFiles.state} <> 'skipped'))::int`,
    })
    .from(docImportFiles)
    .where(eq(docImportFiles.importId, importId));
  return { done: row?.done ?? 0, total: row?.total ?? 0 };
}

const keyPrefix = (key: string) => /^(?:project\/[^/]+\/|org\/|team\/[^/]+\/)/.exec(key)?.[0] ?? null;

// ---- Route --------------------------------------------------------------------------------------------------------

export async function scanImport(tx: Tx, jobs: Jobs, actor: Actor, input: unknown): Promise<DocImport> {
  const data = docImportScanInput.parse(input);
  const home = await homeById(tx, data.homeId);
  await requireHomeManage(tx, actor.userId, home);
  // Khoá theo nhà để hai lần bấm quét cùng lúc không tạo hai lần nhập song song.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`docsync-import:${home.id}`}, 0))`);
  const [running] = await tx
    .select({ id: docImports.id })
    .from(docImports)
    .where(and(eq(docImports.homeId, home.id), inArray(docImports.state, ["scanning", "importing"])))
    .limit(1);
  if (running) throw new ConflictError("DOCSYNC_IMPORT_RUNNING", "Nhà đang có lần quét hoặc nhập chưa xong.");
  // Bản xem trước cũ không còn đúng với lần quét mới; huỷ để không ai nhập nhầm từ nó.
  await tx
    .update(docImports)
    .set({ state: "cancelled", updatedAt: new Date() })
    .where(and(eq(docImports.homeId, home.id), eq(docImports.state, "ready")));
  const [row] = await tx
    .insert(docImports)
    .values({
      orgId: actor.orgId,
      homeId: home.id,
      include: data.include ?? home.include,
      exclude: data.exclude ?? home.exclude,
      startedBy: actor.userId,
    })
    .returning();
  if (!row) throw new Error("Không tạo được lần nhập.");
  await jobs.enqueue(
    DOCSYNC_SCAN_IMPORT_QUEUE,
    { orgId: actor.orgId, homeId: home.id, importId: row.id } satisfies ImportJob,
    { tx, singletonKey: home.id },
  );
  await recordAudit(tx, {
    action: "doc.import.scan",
    targetType: "doc_import",
    targetId: row.id,
    data: { homeId: home.id, include: row.include, exclude: row.exclude },
  });
  return importView(row);
}

export async function getImport(tx: Tx, actor: Actor, id: string): Promise<DocImport> {
  return importView((await managedImport(tx, actor, id)).imp);
}

const filesInput = z.object({
  id: z.uuid(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  state: z.enum(["pending", "done", "skipped", "blocked_secret", "failed"]).optional(),
});

export async function listImportFiles(tx: Tx, actor: Actor, input: z.input<typeof filesInput>) {
  const data = filesInput.parse(input);
  await managedImport(tx, actor, data.id);
  const rows = await tx
    .select()
    .from(docImportFiles)
    .where(
      and(
        eq(docImportFiles.importId, data.id),
        data.state ? eq(docImportFiles.state, data.state) : undefined,
        data.cursor ? sql`${docImportFiles.repoPath} > ${data.cursor}` : undefined,
      ),
    )
    .orderBy(asc(docImportFiles.repoPath))
    .limit(data.limit + 1);
  const items = rows.slice(0, data.limit).map(fileView);
  return { items, nextCursor: rows.length > data.limit ? (items.at(-1)?.path ?? null) : null };
}

const listInput = z.object({
  homeId: z.uuid(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export async function listImports(tx: Tx, actor: Actor, input: z.input<typeof listInput>) {
  const data = listInput.parse(input);
  await requireHomeManage(tx, actor.userId, await homeById(tx, data.homeId));
  let after: { at: Date; id: string } | null = null;
  if (data.cursor) {
    const [at, id] = data.cursor.split("|");
    const time = new Date(at ?? "");
    if (!id || Number.isNaN(time.getTime()) || !z.uuid().safeParse(id).success)
      throw new BadRequestError("DOCSYNC_INVALID_CURSOR", "Con trỏ danh sách lần nhập không hợp lệ.");
    after = { at: time, id };
  }
  const rows = await tx
    .select()
    .from(docImports)
    .where(
      and(
        eq(docImports.homeId, data.homeId),
        after
          ? or(lt(docImports.createdAt, after.at), and(eq(docImports.createdAt, after.at), lt(docImports.id, after.id)))
          : undefined,
      ),
    )
    .orderBy(desc(docImports.createdAt), desc(docImports.id))
    .limit(data.limit + 1);
  const items = rows.slice(0, data.limit);
  const last = items.at(-1);
  return {
    items: items.map(importView),
    nextCursor: rows.length > data.limit && last ? `${last.createdAt.toISOString()}|${last.id}` : null,
  };
}

async function checkResolution(tx: Tx, actor: Actor, file: ImportFileRow, res: Resolution, taken: Set<string>) {
  const invalid = (message: string) => new BadRequestError("DOCSYNC_IMPORT_RESOLUTION", `${file.repoPath}: ${message}`);
  if (file.kind !== "markdown" || !file.key) throw invalid("chỉ tài liệu markdown mới chọn được key.");
  if (res.action === "rename") {
    const prefix = keyPrefix(file.key);
    if (!prefix || !res.key.startsWith(prefix) || /^project\/[^/]+\/sdlc(?:\/|$)/.test(res.key))
      throw invalid(`key mới phải nằm trong phạm vi ${prefix ?? "của nhà"}.`);
    if (taken.has(res.key) || (await existingDoc(tx, res.key))) throw invalid("key mới đã có tài liệu khác.");
    taken.add(res.key);
    return;
  }
  if (res.key !== file.existingKey) throw invalid("chỉ gắn được vào tài liệu trùng key.");
  const doc = await existingDoc(tx, res.key);
  if (!doc || doc.mapped) throw invalid("tài liệu để gắn không còn hoặc đã gắn với repo khác.");
  await assertCanManageScope(tx, actor.userId, { teamId: doc.teamId, projectId: doc.projectId });
  if (doc.version !== res.baseVersion)
    throw new ConflictError(
      "VERSION_CONFLICT",
      `Tài liệu ${res.key} đã ở phiên bản ${doc.version}. Tải bản mới nhất trước khi gắn.`,
    );
}

export async function startImport(tx: Tx, jobs: Jobs, actor: Actor, input: unknown): Promise<DocImport> {
  const data = docImportStartInput.parse(input);
  const { imp, home } = await managedImport(tx, actor, data.importId, true);
  if (imp.state !== "ready") throw stateError("Lần nhập không ở trạng thái sẵn sàng. Hãy quét lại.");
  const files = await tx.select().from(docImportFiles).where(eq(docImportFiles.importId, imp.id));
  const byPath = new Map(files.map((f) => [f.repoPath, f]));
  const wanted = new Set(data.paths);
  for (const path of wanted)
    if (!byPath.has(path))
      throw new BadRequestError("DOCSYNC_IMPORT_PATH", `Không có file ${path} trong bản xem trước.`);
  const resolutions = new Map<string, Resolution>();
  for (const res of data.resolutions ?? []) {
    if (!wanted.has(res.path) || byPath.get(res.path)?.state !== "pending")
      throw new BadRequestError("DOCSYNC_IMPORT_PATH", `File ${res.path} không được chọn để nhập.`);
    resolutions.set(res.path, res);
  }
  const taken = new Set(
    files.flatMap((f) => (f.key && wanted.has(f.repoPath) && !f.existingKey && f.state === "pending" ? [f.key] : [])),
  );
  const now = new Date();
  const skip: string[] = [];
  const unresolved: string[] = [];
  for (const file of files) {
    if (file.state !== "pending") continue;
    if (!wanted.has(file.repoPath)) {
      skip.push(file.id);
      continue;
    }
    const res = resolutions.get(file.repoPath);
    if (res) {
      await checkResolution(tx, actor, file, res, taken);
      if (res.action === "rename")
        await tx.update(docImportFiles).set({ key: res.key, updatedAt: now }).where(eq(docImportFiles.id, file.id));
    } else if (file.existingKey) unresolved.push(file.id);
  }
  for (let i = 0; i < skip.length; i += 1000)
    await tx
      .update(docImportFiles)
      .set({ state: "skipped", updatedAt: now })
      .where(inArray(docImportFiles.id, skip.slice(i, i + 1000)));
  if (unresolved.length)
    await tx
      .update(docImportFiles)
      .set({ state: "skipped", error: `${W.collision}, chưa chọn cách xử lý.`, updatedAt: now })
      .where(inArray(docImportFiles.id, unresolved));
  const progress = await progressOf(tx, imp.id);
  const [row] = await tx
    .update(docImports)
    .set({
      state: "importing",
      selected: [...resolutions.values()],
      progress: { ...progress, cursor: null },
      updatedAt: now,
    })
    .where(eq(docImports.id, imp.id))
    .returning();
  await jobs.enqueue(
    DOCSYNC_IMPORT_QUEUE,
    { orgId: actor.orgId, homeId: home.id, importId: imp.id } satisfies ImportJob,
    { tx, singletonKey: home.id },
  );
  await recordAudit(tx, {
    action: "doc.import.start",
    targetType: "doc_import",
    targetId: imp.id,
    data: { homeId: home.id, files: progress.total, resolutions: resolutions.size },
  });
  return importView(row as ImportRow);
}

export async function cancelImport(tx: Tx, actor: Actor, id: string): Promise<DocImport> {
  const { imp } = await managedImport(tx, actor, id, true);
  if (!["scanning", "ready", "importing"].includes(imp.state)) throw stateError("Lần nhập đã kết thúc.");
  const [row] = await tx
    .update(docImports)
    .set({ state: "cancelled", updatedAt: new Date() })
    .where(eq(docImports.id, imp.id))
    .returning();
  await recordAudit(tx, {
    action: "doc.import.cancel",
    targetType: "doc_import",
    targetId: imp.id,
    data: { homeId: imp.homeId, progress: imp.progress },
  });
  return importView(row as ImportRow);
}

/** Người quản trị xác nhận từng file không phải bí mật; file đã bị chặn thì đưa lại vào hàng nhập. */
export async function confirmSecret(tx: Tx, jobs: Jobs, actor: Actor, input: unknown): Promise<{ queued: boolean }> {
  const data = docImportConfirmSecretInput.parse(input);
  const { imp, home } = await managedImport(tx, actor, data.importId, true);
  const [file] = await tx
    .select()
    .from(docImportFiles)
    .where(and(eq(docImportFiles.importId, imp.id), eq(docImportFiles.repoPath, data.path)))
    .for("update");
  if (!file) throw new NotFoundError("DOCSYNC_IMPORT_FILE_NOT_FOUND", "Không có file này trong lần nhập.");
  const blocked = file.state === "blocked_secret";
  if (!blocked && !(file.state === "pending" && file.secretScan === "found"))
    throw new BadRequestError("DOCSYNC_IMPORT_NO_SECRET", "File không có dấu hiệu bí mật cần xác nhận.");
  if (!["ready", "importing", "done"].includes(imp.state)) throw stateError("Lần nhập đã huỷ hoặc lỗi. Hãy quét lại.");
  const now = new Date();
  await tx
    .update(docImportFiles)
    .set({ confirmedBy: actor.userId, ...(blocked ? { state: "pending", error: null } : {}), updatedAt: now })
    .where(eq(docImportFiles.id, file.id));
  await recordAudit(tx, {
    action: "doc.import.secret_confirm",
    targetType: "doc_import",
    targetId: imp.id,
    data: { homeId: home.id, path: file.repoPath, key: file.key, findings: file.findings },
  });
  if (!blocked || imp.state === "ready") return { queued: false };
  await tx
    .update(docImports)
    .set({ state: "importing", progress: { ...(await progressOf(tx, imp.id)), cursor: null }, updatedAt: now })
    .where(eq(docImports.id, imp.id));
  await jobs.enqueue(
    DOCSYNC_IMPORT_QUEUE,
    { orgId: imp.orgId, homeId: home.id, importId: imp.id } satisfies ImportJob,
    { tx, singletonKey: home.id },
  );
  return { queued: true };
}

// ---- Job ----------------------------------------------------------------------------------------------------------

export type ImportOptions = {
  blobStore?: BlobStore;
  limits?: Partial<DocStorageLimits>;
  signal?: AbortSignal;
};

type ImportContext = {
  job: ImportJob;
  imp: ImportRow;
  home: HomeRow;
  provider: GitProvider;
  ref: RepoRef;
  projectScope: Scope | null;
  resolutions: Map<string, Resolution>;
  blobStore: BlobStore;
  limits: DocStorageLimits;
  jobs: Jobs | undefined;
  pushed: boolean;
};

async function scopeOf(tx: Tx, c: ImportContext, key: string): Promise<Scope> {
  if (c.projectScope) return c.projectScope;
  if (key.startsWith("org/")) return { teamId: null, projectId: null };
  const slug = /^team\/([^/]+)\//.exec(key)?.[1] ?? "";
  const { rows } = await tx.execute<{ id: string }>(sql`select id from hive.teams where slug = ${slug}`);
  const team = rows[0];
  if (!team) throw new Error(`Không tìm thấy đội ${slug} trong tổ chức.`);
  return { teamId: team.id, projectId: null };
}

async function* once(bytes: Uint8Array) {
  yield bytes;
}

async function lfsBytes(c: ImportContext, pointer: { oid: string; size: number }): Promise<Uint8Array | null> {
  if (pointer.size > c.limits.assetMaxBytes) return null;
  try {
    const res = (await c.provider.lfsBatch(c.ref, "download", [pointer])) as {
      objects?: Array<{ actions?: { download?: LfsAction } }>;
    };
    const action = res.objects?.[0]?.actions?.download;
    if (!action) return null;
    const bytes = await lfsDownload(action);
    // Máy chủ LFS có thể trả nhầm đối tượng; chỉ nhận khi đúng oid trong con trỏ.
    return createHash("sha256").update(bytes).digest("hex") === pointer.oid ? bytes : null;
  } catch {
    return null;
  }
}

async function importAsset(tx: Tx, c: ImportContext, entry: RepoEntry): Promise<FilePatch> {
  const base = { orgId: c.job.orgId, homeId: c.home.id, repoPath: entry.path };
  let bytes = entry.size <= c.limits.assetMaxBytes ? entry.bytes : null;
  let lfs = false;
  let row: Partial<typeof docAssets.$inferInsert> = {};
  const pointer = bytes && bytes.length < 200 ? parseLfsPointer(new TextDecoder().decode(bytes)) : null;
  if (pointer) {
    lfs = true;
    bytes = await lfsBytes(c, pointer);
    if (!bytes)
      row = {
        state: pointer.size > c.limits.assetMaxBytes ? "too_large" : "missing_lfs",
        size: pointer.size,
        sha256: pointer.oid,
      };
  } else if (!bytes) row = { state: "too_large", size: entry.size, sha256: entry.sha256 };
  if (bytes) {
    const blob = await c.blobStore.put(tx, c.job.orgId, once(bytes), "application/octet-stream", {
      filename: entry.path.split("/").at(-1) ?? entry.path,
    });
    row = { state: "available", blobId: blob.id, mediaType: blob.mediaType, size: blob.size, sha256: blob.sha256 };
  }
  const [asset] = await tx
    .insert(docAssets)
    .values({
      ...base,
      mediaType: "application/octet-stream",
      size: 0,
      sha256: entry.sha256,
      lfs,
      ...row,
    })
    .onConflictDoNothing()
    .returning();
  if (!asset) return { state: "skipped", error: "Đường dẫn đã có file đính kèm trên hub." };
  if (asset.state === "available" && EXTRACTABLE.test(entry.path)) {
    const [extract] = await tx
      .insert(docExtracts)
      .values({ orgId: c.job.orgId, assetId: asset.id, sourceSha256: asset.sha256 })
      .returning({ id: docExtracts.id });
    await c.jobs?.enqueue(
      DOCSYNC_EXTRACT_QUEUE,
      { orgId: c.job.orgId, assetId: asset.id, extractId: extract?.id },
      { tx, singletonKey: asset.id },
    );
  }
  return asset.state === "available"
    ? { state: "done", assetId: asset.id }
    : { state: "failed", assetId: asset.id, error: asset.state === "too_large" ? W.tooLarge : "Thiếu đối tượng LFS" };
}

async function importMarkdown(tx: Tx, c: ImportContext, file: ImportFileRow, entry: RepoEntry): Promise<FilePatch> {
  const text = entry.lossy || !entry.bytes ? null : decodeUtf8(entry.bytes);
  if (text === null || text.length > DOC_MAX_CHARS || parseLfsPointer(text)) return importAsset(tx, c, entry);
  const findings = scanSecrets(text);
  if (findings.length && !file.confirmedBy) return { state: "blocked_secret", secretScan: "found", findings };
  const secret = { secretScan: findings.length ? ("found" as const) : ("clean" as const), findings };
  const res = c.resolutions.get(file.repoPath);
  const key = file.key;
  if (!key) return { state: "failed", error: W.noKey };
  const content = toLf(text);
  const commit = c.imp.commitSha;
  let docId: string;
  let version: number | null;
  let state: "synced" | "pending" = "synced";
  if (res?.action === "attach") {
    const doc = await existingDoc(tx, key);
    if (!doc || doc.mapped) return { ...secret, state: "failed", error: "Tài liệu để gắn không còn hoặc đã gắn repo." };
    if (res.choice === "repo") {
      const saved = await saveDocFromSync(tx, {
        key,
        title: titleOf(content, file.repoPath),
        content,
        baseVersion: res.baseVersion,
        scope: { teamId: doc.teamId, projectId: doc.projectId },
        source: "import",
        repoCommit: commit,
        message: "Gắn tài liệu với repo, lấy bản trong repo.",
        secretsAcknowledged: Boolean(file.confirmedBy),
      });
      docId = saved.id;
      version = saved.version;
    } else {
      // Giữ bản hub: ghi nhận bản repo là bản đã đồng bộ để lần đẩy sau thay nó bằng bản hub.
      docId = doc.id;
      version = null;
      state = "pending";
    }
  } else {
    if (file.existingKey && res?.action !== "rename")
      return { ...secret, state: "failed", error: "Key đã có tài liệu khác; quét lại để chọn cách xử lý." };
    const saved = await saveDocFromSync(tx, {
      key,
      title: titleOf(content, file.repoPath),
      content,
      baseVersion: 0,
      scope: await scopeOf(tx, c, key),
      source: "import",
      repoCommit: commit,
      message: "Nhập từ repo.",
      secretsAcknowledged: Boolean(file.confirmedBy),
    });
    docId = saved.id;
    version = saved.version;
  }
  const [mapped] = await tx
    .insert(docRepoFiles)
    .values({
      orgId: c.job.orgId,
      docId,
      homeId: c.home.id,
      repoPath: file.repoPath,
      syncedVersion: version,
      syncedCommit: commit,
      syncedHash: entry.sha256,
      repoHash: entry.sha256,
      state,
      eol: detectEol(text),
      bom: hasBom(text),
    })
    .onConflictDoNothing()
    .returning({ id: docRepoFiles.id });
  if (!mapped) throw new Error("Đường dẫn hoặc tài liệu đã gắn với file khác trong repo.");
  if (state === "pending") c.pushed = true;
  return { ...secret, state: "done", docId };
}

async function importBatch(tx: Tx, c: ImportContext, entries: RepoEntry[]): Promise<boolean> {
  const [imp] = await tx.select().from(docImports).where(eq(docImports.id, c.imp.id)).for("update");
  if (imp?.state !== "importing") return false;
  const files = await tx
    .select()
    .from(docImportFiles)
    .where(
      and(
        eq(docImportFiles.importId, c.imp.id),
        eq(docImportFiles.state, "pending"),
        inArray(
          docImportFiles.repoPath,
          entries.map((e) => e.path),
        ),
      ),
    );
  const byPath = new Map(files.map((f) => [f.repoPath, f]));
  for (const entry of entries) {
    const file = byPath.get(entry.path);
    if (!file) continue;
    // withTenant tự mở transaction nên tx.transaction() không thành savepoint; một file lỗi không được làm hỏng cả lô.
    await tx.execute(sql`savepoint import_file`);
    let patch: FilePatch;
    try {
      patch = file.kind === "markdown" ? await importMarkdown(tx, c, file, entry) : await importAsset(tx, c, entry);
      await tx.execute(sql`release savepoint import_file`);
    } catch (error) {
      await tx.execute(sql`rollback to savepoint import_file`);
      patch = { state: "failed", error: errorText(error) };
    }
    await tx
      .update(docImportFiles)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(docImportFiles.id, file.id));
  }
  await tx
    .update(docImports)
    .set({
      progress: { ...(await progressOf(tx, c.imp.id)), cursor: entries.at(-1)?.path ?? null },
      updatedAt: new Date(),
    })
    .where(eq(docImports.id, c.imp.id));
  return true;
}

async function finishImport(
  tx: Tx,
  deps: DocSyncDeps,
  c: ImportContext,
  attempted: ReadonlySet<string>,
  error?: unknown,
) {
  const [imp] = await tx.select().from(docImports).where(eq(docImports.id, c.imp.id)).for("update");
  if (imp?.state !== "importing") return;
  const now = new Date();
  if (error === undefined && attempted.size) {
    const missing = [...attempted];
    for (let i = 0; i < missing.length; i += 1000)
      await tx
        .update(docImportFiles)
        .set({ state: "failed", error: "Không đọc được file trong repo.", updatedAt: now })
        .where(
          and(
            eq(docImportFiles.importId, imp.id),
            eq(docImportFiles.state, "pending"),
            inArray(docImportFiles.repoPath, missing.slice(i, i + 1000)),
          ),
        );
  }
  const counts = await tx
    .select({ state: docImportFiles.state, n: sql<number>`count(*)::int` })
    .from(docImportFiles)
    .where(eq(docImportFiles.importId, imp.id))
    .groupBy(docImportFiles.state);
  const n = (state: string) => counts.find((r) => r.state === state)?.n ?? 0;
  // File vừa được xác nhận bí mật trong lúc chạy: job kế tiếp đã xếp hàng sẽ nhập nốt rồi mới báo xong.
  if (error === undefined && n("pending") > 0) return;
  const { rows } = await tx.execute<{ w: string }>(sql`
    select distinct w from hive.doc_import_files, unnest(warnings) as w where import_id = ${imp.id} order by w limit 50`);
  const report = {
    imported: n("done"),
    skipped: n("skipped"),
    blockedSecret: n("blocked_secret"),
    failed: n("failed"),
    warnings: rows.map((r) => r.w),
  };
  await tx
    .update(docImports)
    .set({
      state: error === undefined ? "done" : "failed",
      error: error === undefined ? null : errorText(error),
      report,
      progress: { ...(await progressOf(tx, imp.id)), cursor: null },
      updatedAt: now,
    })
    .where(eq(docImports.id, imp.id));
  if (c.pushed && deps.jobs) await queuePush(deps.jobs, { orgId: imp.orgId, homeId: imp.homeId }, { tx });
  await notify(
    tx,
    {
      orgId: imp.orgId,
      event: "docsync.import_done",
      title: error === undefined ? "Đã nhập tài liệu từ repo" : "Nhập tài liệu từ repo bị lỗi",
      body:
        `${c.home.owner}/${c.home.name}: nhập ${report.imported} file, bỏ qua ${report.skipped}, ` +
        `chặn vì nghi bí mật ${report.blockedSecret}, lỗi ${report.failed}.` +
        (error === undefined ? "" : ` ${errorText(error)}`),
      eventKey: `${imp.id}:${report.imported}:${report.blockedSecret}:${report.failed}`,
      recipientIds: [imp.startedBy],
    },
    { jobs: deps.jobs },
  );
}

/** Nhập các file pending của lần nhập. Chạy lại an toàn: file đã xong không còn pending nên không nhập trùng. */
export async function runImport(deps: DocSyncDeps, job: ImportJob, opts: ImportOptions = {}): Promise<void> {
  const pool = deps.pool as pg.Pool;
  const limits = { ...loadDocStorageLimits(), ...opts.limits };
  const blobStore = opts.blobStore ?? createPostgresBlobStore({ limits, ...(deps.jobs ? { jobs: deps.jobs } : {}) });
  const ctx = { orgId: job.orgId };
  const loaded = await withTenant(pool, ctx, async (tx) => {
    const [imp] = await tx.select().from(docImports).where(eq(docImports.id, job.importId));
    if (imp?.state !== "importing" || !imp.commitSha) return null;
    const home = await homeById(tx, imp.homeId);
    const provider = await homeProvider(tx, deps, home.connectionId);
    const project = home.projectId ? await loadProject(tx, home.projectId) : null;
    const pending = await tx
      .select({ path: docImportFiles.repoPath })
      .from(docImportFiles)
      .where(and(eq(docImportFiles.importId, imp.id), eq(docImportFiles.state, "pending")));
    return { imp, home, provider, project, paths: pending.map((p) => p.path) };
  });
  if (!loaded) return;
  const c: ImportContext = {
    job,
    imp: loaded.imp,
    home: loaded.home,
    provider: loaded.provider,
    ref: repoRef(loaded.home),
    projectScope: loaded.project ? { teamId: loaded.project.teamId, projectId: loaded.project.id } : null,
    resolutions: new Map((loaded.imp.selected as Resolution[]).map((r) => [r.path, r])),
    blobStore,
    limits,
    jobs: deps.jobs,
    pushed: false,
  };
  const remaining = new Set(loaded.paths);
  let batch: RepoEntry[] = [];
  let bytes = 0;
  const flush = async () => {
    if (!batch.length) return true;
    const entries = batch;
    batch = [];
    bytes = 0;
    const ok = await withTenant(pool, ctx, (tx) => importBatch(tx, c, entries));
    if (ok) for (const e of entries) remaining.delete(e.path);
    return ok;
  };
  try {
    for await (const entry of readRepoFiles(c.provider, c.ref, c.imp.commitSha as string, new Set(loaded.paths), {
      archive: useArchive(loaded.paths),
      maxBytes: limits.importMaxBytes,
      keep: (_path, size) => size <= limits.assetMaxBytes,
    })) {
      opts.signal?.throwIfAborted();
      batch.push(entry);
      bytes += entry.bytes?.length ?? 0;
      if ((batch.length >= IMPORT_BATCH_FILES || bytes >= IMPORT_BATCH_BYTES) && !(await flush())) return;
    }
    if (!(await flush())) return;
  } catch (error) {
    if (deps.jobs && (await retryLater(deps.jobs, DOCSYNC_IMPORT_QUEUE, job, error))) return;
    if (opts.signal?.aborted) throw error;
    await withTenant(pool, ctx, (tx) => finishImport(tx, deps, c, remaining, error));
    return;
  }
  await withTenant(pool, ctx, (tx) => finishImport(tx, deps, c, remaining));
}

export async function registerImport(jobs: Jobs, deps: DocSyncDeps): Promise<void> {
  // Tiến trình chỉ gửi job (không có pool) thì không nhận việc.
  if (!deps.pool) return;
  const withJobs = { ...deps, jobs };
  await jobs.work<ImportJob>(DOCSYNC_SCAN_IMPORT_QUEUE, ({ data }) => runScan(withJobs, data));
  await jobs.work<ImportJob>(DOCSYNC_IMPORT_QUEUE, ({ data, signal }) => runImport(withJobs, data, { signal }));
}
