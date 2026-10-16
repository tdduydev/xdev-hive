import { matchGlob } from "@xdev-hive/contracts";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { auditByData, recordAudit } from "../audit/index.ts";
import { enqueueMerge, findProject, loadProject } from "../catalog/index.ts";
import { authUser } from "../identity/index.ts";
import { type DocSavedEvent, provideDocSaved } from "../knowledge/index.ts";
import { notify } from "../notify/index.ts";
import { BadRequestError, createPostgresBlobStore, type Jobs, type Tx, withTenant } from "../platform/index.ts";
import {
  type CommitFilesInput,
  defaultProviderFactory,
  type GitProvider,
  isGitProviderError,
  lfsUpload,
  loadConnection,
  onScmEvent,
  type PullRequestEvent,
  type ScmEventContext,
} from "../scm/index.ts";
import { notificationRecipients, teamMemberIds } from "../tenancy/index.ts";
import { contentHash, type Eol, fromLf, isLfsPath, type LfsRule, lfsPointer, parseGitattributes } from "./content.ts";
import { type PathHome, pathFromKey } from "./paths.ts";
import type { DocSyncDeps } from "./routes/deps.ts";
import { docAssets, docHomes, docRepoFiles, docSyncBatches } from "./schema.ts";

/*
 * Hub → repo (spec 018 US2, FR-012…FR-016, FR-024, FR-027; plan.md mục 5). Lần lưu chỉ đánh dấu file `pending` và xếp
 * job theo nhà; job gom mọi file đang chờ thành một commit. Đọc và ghi database trong transaction ngắn, gọi Git ở
 * ngoài transaction như `sdlc/sync.ts`.
 */

// jobs.ts import file này để đăng ký handler, homes.ts import jobs.ts: import ngược bất kỳ file nào trong hai file đó là
// vòng phụ thuộc (dependency-cruiser chặn), nên tên queue và cách mở provider lặp lại ở đây.
const PUSH_QUEUE = "docsync-push";
const PULL_QUEUE = "docsync-pull";
const PULL_DEBOUNCE_MS = 30_000;
/** Gom 60 giây từ lần lưu cuối, nhưng không giữ lâu hơn 10 phút từ lần lưu đầu (Q5). */
export const PUSH_DEBOUNCE_MS = 60_000;
export const PUSH_MAX_WAIT_MS = 10 * 60_000;
/** Như `SYNC_RETRY_MINUTES` của sdlc/sync.ts (FR-015). */
export const PUSH_RETRY_MINUTES = [1, 2, 5, 10, 20, 30] as const;
export const DOCS_STATUS_CONTEXT = "xdev-hive/docs";
/** Lô `pushing` cũ hơn mức này coi như worker đã chết giữa chừng; lô mới được lấy lại. */
const PUSH_LEASE_MS = 10 * 60_000;
const SYSTEM_ACTOR = "system:docsync";
const MAX_FILES = 500;
const MAX_ERROR = 500;

export interface DocSyncPushJob {
  orgId: string;
  homeId: string;
  /** "Đồng bộ ngay": bỏ qua thời gian gom và lịch thử lại. */
  now?: boolean;
}

export type PushOutcome = "skipped" | "waiting" | "busy" | "empty" | "pushed" | "failed";

type Home = typeof docHomes.$inferSelect;
type FileRow = typeof docRepoFiles.$inferSelect;
type AssetRow = typeof docAssets.$inferSelect;
type Batch = typeof docSyncBatches.$inferSelect;
type PushDeps = DocSyncDeps & { pool: NonNullable<DocSyncDeps["pool"]> };

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, MAX_ERROR);

// drizzle trải mảng JS thành `($1, $2)` chứ không thành một tham số mảng.
export const uuidArray = (ids: readonly string[]) =>
  sql`array[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;

/** Một nhánh mỗi nhà để hai nhà chung repo (nhà dự án và nhà tổ chức) không ghi đè PR của nhau (FR-014). */
export const syncBranchName = (projectKey: string | null) => `hive/docs-sync-${projectKey ?? "org"}`;

export function pathHomeOf(home: Home, projectKey: string | null): PathHome {
  return home.scope === "project" && projectKey
    ? { scope: "project", projectKey, root: home.root }
    : { scope: "org", root: home.root };
}

export async function projectKeyOf(tx: Tx, home: Pick<Home, "projectId">): Promise<string | null> {
  if (!home.projectId) return null;
  return (await loadProject(tx, home.projectId))?.key ?? null;
}

export function retryDelayMs(attempt: number): number | null {
  const minutes = PUSH_RETRY_MINUTES[attempt - 1];
  return minutes === undefined ? null : minutes * 60_000;
}

export function pushCommitMessage(input: {
  docs: number;
  assets: number;
  batchId: string;
  coAuthors: { name: string; email: string }[];
}): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const parts = [
    ...(input.docs || !input.assets ? [plural(input.docs, "document")] : []),
    ...(input.assets ? [plural(input.assets, "attachment")] : []),
  ];
  const seen = new Set<string>();
  const authors = input.coAuthors.filter((a) => {
    const k = a.email.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return [
    `docs: sync ${parts.join(" and ")} from xDev Hive`,
    "",
    `Hive-Doc-Sync: ${input.batchId}`,
    ...authors.map((a) => `Co-authored-by: ${a.name || a.email} <${a.email}>`),
  ].join("\n");
}

async function enqueuePush(tx: Tx, jobs: Jobs | undefined, job: DocSyncPushJob, delayMs: number) {
  if (!jobs) return null;
  // "Đồng bộ ngay" dùng khoá riêng: job thường có thể đang chờ tới lượt thử lại 30 phút, pg-boss không thay được job
  // đó. Hai job cùng chạy thì lease của lô `pushing` chặn job sau.
  return jobs.enqueue(PUSH_QUEUE, job, {
    tx,
    singletonKey: job.now ? `${job.homeId}:now` : job.homeId,
    startAfter: new Date(Date.now() + Math.max(0, delayMs)),
  });
}

async function enqueuePull(tx: Tx, jobs: Jobs | undefined, job: { orgId: string; homeId: string }) {
  if (!jobs) return;
  await jobs.enqueue(PULL_QUEUE, job, {
    tx,
    singletonKey: job.homeId,
    startAfter: new Date(Date.now() + PULL_DEBOUNCE_MS),
  });
}

async function providerFor(tx: Tx, deps: DocSyncDeps, connectionId: string): Promise<GitProvider> {
  if (!deps.masterKey) throw new BadRequestError("MASTER_KEY_MISSING", "Hub chưa cấu hình HIVE_MASTER_KEY.");
  const conn = await loadConnection(tx, deps.masterKey, connectionId);
  if (!conn) throw new Error("Không tìm thấy kết nối Git của nhà tài liệu.");
  return (deps.providerFactory ?? defaultProviderFactory)(conn);
}

// ---- Hook lưu tài liệu --------------------------------------------------------------------------------------------

/** Trạng thái được đưa lại về `pending` khi hub có phiên bản mới; xung đột và bí mật chờ người xử lý. */
export const REQUEUE_STATES: ReadonlySet<string> = new Set(["synced", "pending", "failed", "deleted_in_repo"]);

async function homeForKey(tx: Tx, key: string): Promise<{ home: Home; projectKey: string | null } | null> {
  const projectKey = /^project\/([^/]+)\//.exec(key)?.[1];
  if (projectKey) {
    const project = await findProject(tx, projectKey);
    if (!project) return null;
    const [home] = await tx.select().from(docHomes).where(eq(docHomes.projectId, project.id));
    return home ? { home, projectKey } : null;
  }
  if (!/^(?:org|team)\//.test(key)) return null;
  const [home] = await tx.select().from(docHomes).where(eq(docHomes.scope, "org"));
  return home ? { home, projectKey: null } : null;
}

/** Ghi mốc gom rồi xếp job; nhà tạm dừng vẫn giữ file `pending`, `resume` xếp job đẩy. */
export async function queueHomePush(tx: Tx, jobs: Jobs | undefined, home: Home): Promise<void> {
  await tx
    .update(docHomes)
    .set({ firstQueuedAt: sql`coalesce(${docHomes.firstQueuedAt}, now())`, lastSavedAt: sql`now()` })
    .where(eq(docHomes.id, home.id));
  if (home.status === "active" && home.mode !== "off")
    await enqueuePush(tx, jobs, { orgId: home.orgId, homeId: home.id }, PUSH_DEBOUNCE_MS);
}

/**
 * Chạy trong transaction lưu của knowledge (FR-012): rollback thì không có job. Phiên bản nguồn `repo` đã nằm trong
 * repo nên không đẩy lại. Bản `import` cũng lấy từ repo, và bước nhập tự gắn đúng đường dẫn gốc ngay sau khi lưu;
 * hook mà gắn trước thì tài liệu bị gắn vào `<root>/<key>.md` và bước nhập đụng ràng buộc một tài liệu một file.
 */
export async function onDocSaved(tx: Tx, event: DocSavedEvent, jobs: Jobs | undefined): Promise<void> {
  if (event.change === "save" && (event.source === "repo" || event.source === "import")) return;
  const [row] = await tx.select().from(docRepoFiles).where(eq(docRepoFiles.docId, event.docId));
  let home: Home | undefined;
  if (row) {
    if (!REQUEUE_STATES.has(row.state)) return;
    [home] = await tx.select().from(docHomes).where(eq(docHomes.id, row.homeId));
    if (!home || home.mode === "off") return;
    await tx
      .update(docRepoFiles)
      .set({ state: "pending", error: null, updatedAt: new Date() })
      .where(eq(docRepoFiles.id, row.id));
  } else {
    if (event.change === "archive") return;
    const found = await homeForKey(tx, event.key);
    if (!found || found.home.mode === "off") return;
    home = found.home;
    let path: string;
    try {
      path = pathFromKey(event.key, pathHomeOf(home, found.projectKey));
    } catch {
      return;
    }
    // Tài liệu mới luôn ghi vào root của nhà; chỉ mẫu loại trừ của nhà chặn được nó.
    if (home.exclude.some((glob) => matchGlob(glob, path))) return;
    const inserted = await tx
      .insert(docRepoFiles)
      .values({ orgId: event.orgId, docId: event.docId, homeId: home.id, repoPath: path, state: "pending" })
      .onConflictDoNothing()
      .returning({ id: docRepoFiles.id });
    if (!inserted.length) return;
  }
  await queueHomePush(tx, jobs, home);
}

export function docSavedHandler(jobs: Jobs | undefined) {
  return (tx: Tx, event: DocSavedEvent) => onDocSaved(tx, event, jobs);
}

// ---- Di chuyển ----------------------------------------------------------------------------------------------------

export const MOVE_ACTION = "doc.move";

/**
 * Nơi file đang nằm trong repo nếu đã bị di chuyển trên hub mà chưa đẩy. Bảng không có cột đường dẫn cũ (T005 sở hữu
 * schema), nên `move` ghi đường dẫn gốc vào audit kèm `synced_commit` lúc di chuyển; đẩy xong thì commit đổi nên
 * dòng audit cũ tự hết hiệu lực.
 */
export async function moveOrigin(tx: Tx, row: FileRow): Promise<string | null> {
  if (!row.syncedHash) return null;
  const [last] = await auditByData(tx, { actionLike: MOVE_ACTION, key: "docId", value: row.docId, limit: 1 });
  const data = last?.data as { from?: unknown; to?: unknown; syncedCommit?: unknown } | undefined;
  if (!data || data.to !== row.repoPath || data.syncedCommit !== (row.syncedCommit ?? null)) return null;
  return typeof data.from === "string" && data.from !== row.repoPath ? data.from : null;
}

// ---- Lập lô -------------------------------------------------------------------------------------------------------

interface PlannedDoc {
  row: FileRow;
  version: number;
  archived: boolean;
  /** Nơi file nằm trong repo trước lô này; khác `row.repoPath` khi di chuyển. */
  from: string;
  /** null: xoá file. */
  content: string | null;
  hash: string | null;
}

interface PlannedAsset {
  row: AssetRow;
  bytes: Uint8Array;
}

interface PushPlan {
  home: Home;
  projectKey: string | null;
  batch: Batch;
  docs: PlannedDoc[];
  assets: PlannedAsset[];
  coAuthors: { name: string; email: string }[];
  mergeQueue: boolean;
  provider: GitProvider;
}

type VersionRow = {
  id: string;
  current_version: number;
  archived_at: Date | null;
  content: string;
  source: string;
  secret_flag: boolean;
};

async function readBlob(tx: Tx, orgId: string, blobId: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of await createPostgresBlobStore().get(tx, orgId, blobId)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function coAuthorsOf(tx: Tx, fileIds: string[]): Promise<{ name: string; email: string }[]> {
  if (!fileIds.length) return [];
  const { rows } = await tx.execute<{ id: string }>(sql`
    select distinct v.author_user_id as id
      from hive.doc_versions v join hive.doc_repo_files f on f.doc_id = v.doc_id
     where f.id = any(${uuidArray(fileIds)}) and v.version > coalesce(f.synced_version, 0)
       and v.source <> 'repo' and v.author_user_id is not null
  `);
  if (!rows.length) return [];
  const people = await tx
    .select({ name: authUser.name, email: authUser.email })
    .from(authUser)
    .where(
      inArray(
        authUser.id,
        rows.map((r) => r.id),
      ),
    );
  return people.filter((p): p is { name: string; email: string } => Boolean(p.email));
}

async function planPush(tx: Tx, deps: PushDeps, job: DocSyncPushJob): Promise<PushPlan | PushOutcome> {
  const now = Date.now();
  // Khoá dòng nhà: hai job (thường và "Đồng bộ ngay") lập lô nối tiếp nhau, không cùng lấy một lô.
  const [home] = await tx.select().from(docHomes).where(eq(docHomes.id, job.homeId)).for("update");
  if (!home || home.mode === "off" || home.status !== "active") return "skipped";
  if (!job.now && home.lastSavedAt && home.firstQueuedAt) {
    const due = Math.min(
      home.lastSavedAt.getTime() + PUSH_DEBOUNCE_MS,
      home.firstQueuedAt.getTime() + PUSH_MAX_WAIT_MS,
    );
    if (due > now) {
      await enqueuePush(tx, deps.jobs, { orgId: job.orgId, homeId: job.homeId }, due - now);
      return "waiting";
    }
  }
  const [open] = await tx
    .select()
    .from(docSyncBatches)
    .where(
      and(
        eq(docSyncBatches.homeId, home.id),
        inArray(docSyncBatches.state, ["queued", "pushing", "failed"]),
        isNull(docSyncBatches.commitSha),
      ),
    )
    .orderBy(desc(docSyncBatches.createdAt))
    .limit(1);
  if (open?.state === "pushing" && open.updatedAt.getTime() > now - PUSH_LEASE_MS) {
    await enqueuePush(tx, deps.jobs, { orgId: job.orgId, homeId: job.homeId }, PUSH_DEBOUNCE_MS);
    return "busy";
  }
  if (!job.now && open?.state === "failed" && open.nextAt && open.nextAt.getTime() > now) {
    await enqueuePush(tx, deps.jobs, { orgId: job.orgId, homeId: job.homeId }, open.nextAt.getTime() - now);
    return "waiting";
  }
  // Lô đã hết lượt (nextAt null) không dùng lại: lần lưu mới hoặc "Đồng bộ ngay" bắt đầu lại lịch thử.
  const reuse = open && !(open.state === "failed" && open.nextAt === null) ? open : null;

  const rows = await tx
    .select()
    .from(docRepoFiles)
    .where(and(eq(docRepoFiles.homeId, home.id), inArray(docRepoFiles.state, ["pending", "failed"])))
    .orderBy(docRepoFiles.repoPath)
    .limit(MAX_FILES);
  const versions = new Map<string, VersionRow>();
  if (rows.length) {
    const { rows: found } = await tx.execute<VersionRow>(sql`
      select d.id, d.current_version, d.archived_at, v.content, v.source, v.secret_flag
        from hive.docs d join hive.doc_versions v on v.doc_id = d.id and v.version = d.current_version
       where d.id = any(${uuidArray(rows.map((r) => r.docId))})
    `);
    for (const v of found) versions.set(v.id, v);
  }
  const docs: PlannedDoc[] = [];
  for (const row of rows) {
    const v = versions.get(row.docId);
    if (!v) continue;
    const archived = v.archived_at !== null;
    const from = (await moveOrigin(tx, row)) ?? row.repoPath;
    if (archived) {
      if (row.syncedHash) docs.push({ row, version: v.current_version, archived, from, content: null, hash: null });
      else await settle(tx, row, { state: "synced", syncedVersion: v.current_version });
      continue;
    }
    // FR-016: không đẩy phiên bản bị chặn vì bí mật.
    if (v.secret_flag) {
      await settle(tx, row, {
        state: "blocked_secret",
        error: "Phiên bản mới nhất có dấu hiệu bí mật, chưa đẩy lên repo.",
      });
      continue;
    }
    // Phiên bản nguồn `repo` đã nằm trong repo; luồng kéo ghi hash cho nó.
    if (v.source === "repo") {
      await settle(tx, row, { state: "synced", syncedVersion: v.current_version });
      continue;
    }
    const content = fromLf(v.content, row.eol as Eol, row.bom);
    const hash = contentHash(content);
    if (hash === row.syncedHash && from === row.repoPath) {
      await settle(tx, row, { state: "synced", syncedVersion: v.current_version });
      continue;
    }
    docs.push({ row, version: v.current_version, archived, from, content, hash });
  }
  const assetRows = await tx
    .select()
    .from(docAssets)
    .where(and(eq(docAssets.homeId, home.id), eq(docAssets.state, "pending_push")))
    .orderBy(docAssets.repoPath)
    .limit(MAX_FILES);
  const assets: PlannedAsset[] = [];
  for (const row of assetRows) if (row.blobId) assets.push({ row, bytes: await readBlob(tx, home.orgId, row.blobId) });

  if (!docs.length && !assets.length) {
    await tx.update(docHomes).set({ firstQueuedAt: null }).where(eq(docHomes.id, home.id));
    if (reuse)
      await tx
        .update(docSyncBatches)
        .set({ state: "done", error: null, nextAt: null, updatedAt: new Date() })
        .where(eq(docSyncBatches.id, reuse.id));
    return "empty";
  }

  const projectKey = await projectKeyOf(tx, home);
  const project = home.projectId ? await loadProject(tx, home.projectId) : null;
  const mode = home.mode === "direct" ? "direct" : "pr";
  const values = {
    mode,
    branch: mode === "direct" ? home.branch : syncBranchName(projectKey),
    docVersions: docs.map((d) => ({ docId: d.row.docId, version: d.version })),
    assetIds: assets.map((a) => a.row.id),
    state: "pushing",
    error: null,
    nextAt: null,
    updatedAt: new Date(),
  };
  const [batch] = reuse
    ? await tx
        .update(docSyncBatches)
        .set({ ...values, attempts: reuse.attempts + 1 })
        .where(eq(docSyncBatches.id, reuse.id))
        .returning()
    : await tx
        .insert(docSyncBatches)
        .values({ ...values, orgId: home.orgId, homeId: home.id, attempts: 1 })
        .returning();
  // Lần lưu sau thời điểm này bắt đầu một đợt gom mới.
  await tx.update(docHomes).set({ firstQueuedAt: null }).where(eq(docHomes.id, home.id));
  return {
    home,
    projectKey,
    batch: batch as Batch,
    docs,
    assets,
    coAuthors: await coAuthorsOf(
      tx,
      docs.map((d) => d.row.id),
    ),
    mergeQueue: Boolean(project?.settings.features.mergeQueue),
    provider: await providerFor(tx, deps, home.connectionId),
  };
}

async function settle(tx: Tx, row: FileRow, set: Partial<FileRow>) {
  await tx
    .update(docRepoFiles)
    .set({ error: null, ...set, updatedAt: new Date() })
    .where(eq(docRepoFiles.id, row.id));
}

// ---- Ghi repo -----------------------------------------------------------------------------------------------------

class BranchProtectedError extends Error {}

interface PushResult {
  /** Đầu nhánh của nhà lúc kiểm FR-016. */
  head: string;
  /** null: không có gì ghi được (mọi file bị bỏ vì repo đổi). */
  sha: string | null;
  pr: { number: number; url: string; branch: string } | null;
  /** Đã ghi; tài liệu bị bỏ vì repo đổi chưa kéo về (FR-016) nằm ở `skipped`. */
  docs: PlannedDoc[];
  assets: Array<PlannedAsset & { lfs: boolean }>;
  skipped: PlannedDoc[];
  skippedAssets: PlannedAsset[];
}

function isProtection(e: unknown): boolean {
  if (isGitProviderError(e, "forbidden")) return true;
  return (
    isGitProviderError(e) &&
    (e.status === 409 || e.status === 422) &&
    /protect|bảo vệ|required status|pull request/i.test(e.message)
  );
}

type LfsBatchResponse = {
  objects?: Array<{
    oid: string;
    actions?: { upload?: { href: string; header?: Record<string, string> } };
    error?: { message?: string };
  }>;
};

async function uploadLfs(provider: GitProvider, ref: { owner: string; name: string }, assets: PlannedAsset[]) {
  if (!assets.length) return;
  const objects = assets.map((a) => ({ oid: a.row.sha256, size: a.bytes.byteLength }));
  const response = (await provider.lfsBatch(ref, "upload", objects)) as LfsBatchResponse;
  for (const object of response.objects ?? []) {
    if (object.error) throw new Error(`LFS từ chối đối tượng ${object.oid}: ${object.error.message ?? ""}`.trim());
    const asset = assets.find((a) => a.row.sha256 === object.oid);
    // Không có action upload là máy chủ LFS đã có đối tượng.
    if (asset && object.actions?.upload) await lfsUpload(object.actions.upload, asset.bytes);
  }
}

async function pushPlan(deps: PushDeps, plan: PushPlan): Promise<PushResult> {
  const { home, provider } = plan;
  const ref = { owner: home.owner, name: home.name };
  const head = await provider.branchHead(ref, home.branch);
  if (!head) throw new Error(`Không tìm thấy nhánh ${home.branch} trong repo.`);
  const tree = new Set(await provider.listFiles(ref, head));
  // Một lời gọi compare cho cả lô: file không đổi kể từ commit đã biết thì dùng hash đã lưu, khỏi đọc từng file.
  const changed = home.lastCommit ? await provider.compare(ref, home.lastCommit, head).catch(() => null) : null;
  const touched =
    changed && !changed.incomplete
      ? new Set(changed.files.flatMap((f) => (f.previousPath ? [f.path, f.previousPath] : [f.path])))
      : null;
  const hashAt = async (path: string, known: string | null): Promise<string | null> => {
    if (!tree.has(path)) return null;
    if (known && touched && !touched.has(path)) return known;
    const content = await provider.readFile(ref, path, head);
    return content === null ? null : contentHash(content);
  };

  const docs: PlannedDoc[] = [];
  const skipped: PlannedDoc[] = [];
  for (const d of plan.docs) {
    // FR-016: repo chỉ được ở bản hub đã đẩy (syncedHash) hoặc bản đã thấy trên nhánh chính (repoHash, chế độ pr khi
    // PR chưa merge). Khác thì có người sửa repo mà hub chưa kéo về.
    const expected = new Set([d.row.syncedHash, d.row.repoHash]);
    const current = await hashAt(d.from, d.row.repoHash ?? d.row.syncedHash);
    const moveBlocked = d.from !== d.row.repoPath && tree.has(d.row.repoPath);
    if ((expected.has(current) || (current !== null && current === d.hash)) && !moveBlocked) docs.push(d);
    else skipped.push(d);
  }
  const lfsRules: LfsRule[] = [
    ...(tree.has(".gitattributes")
      ? parseGitattributes((await provider.readFile(ref, ".gitattributes", head)) ?? "")
      : []),
    ...parseGitattributes(home.lfsPatterns.map((p) => `${p} filter=lfs`).join("\n")),
  ];
  const assets: PushResult["assets"] = [];
  const skippedAssets: PlannedAsset[] = [];
  for (const a of plan.assets) {
    // Đính kèm mới không ghi đè file nhị phân đã có ở cùng đường dẫn.
    if (tree.has(a.row.repoPath)) skippedAssets.push(a);
    else assets.push({ ...a, lfs: a.row.lfs || isLfsPath(a.row.repoPath, lfsRules) });
  }
  if (!docs.length && !assets.length) return { head, sha: null, pr: null, docs, assets, skipped, skippedAssets };

  await uploadLfs(
    provider,
    ref,
    assets.filter((a) => a.lfs),
  );
  const files: CommitFilesInput["files"] = [];
  for (const d of docs) {
    if (d.content === null) files.push({ path: d.from, delete: true });
    else {
      // Provider giữ lịch sử khi có "move" (FR-024); nội dung mới ghi đè sau đó trong cùng commit.
      if (d.from !== d.row.repoPath) files.push({ path: d.row.repoPath, previousPath: d.from });
      if (d.hash !== d.row.syncedHash || d.from === d.row.repoPath)
        files.push({ path: d.row.repoPath, content: d.content });
    }
  }
  for (const a of assets)
    files.push(
      a.lfs
        ? { path: a.row.repoPath, content: lfsPointer(a.row.sha256, a.bytes.byteLength) }
        : { path: a.row.repoPath, bytes: a.bytes },
    );
  const message = pushCommitMessage({
    docs: docs.length,
    assets: assets.length,
    batchId: plan.batch.id,
    coAuthors: plan.coAuthors,
  });

  if (home.mode === "direct") {
    try {
      const { sha } = await provider.commitFiles(ref, { branch: home.branch, expectedHead: head, message, files });
      return { head, sha, pr: null, docs, assets, skipped, skippedAssets };
    } catch (e) {
      if (isProtection(e)) throw new BranchProtectedError(errorText(e));
      throw e;
    }
  }
  const branch = syncBranchName(plan.projectKey);
  const prHead = await provider.branchHead(ref, branch);
  const { sha } = await provider.commitFiles(ref, {
    branch,
    fromBranch: home.branch,
    message,
    files,
    ...(prHead ? { expectedHead: prHead } : {}),
  });
  const link = deps.publicUrl ? `${deps.publicUrl.replace(/\/+$/, "")}/docs` : null;
  const pr = await provider.openPR(ref, {
    head: branch,
    base: home.branch,
    title: "docs: sync documents from xDev Hive",
    body: [
      "Tài liệu sửa trên xDev Hive. Mỗi lô đồng bộ thêm một commit vào PR này.",
      "Sửa nội dung trên hub thay vì sửa trực tiếp nhánh này.",
      ...(link ? ["", link] : []),
    ].join("\n"),
  });
  // Nội dung đã qua quyền sửa và cổng duyệt của hub: status thay cho người duyệt mà bảo vệ nhánh đòi (như sdlc).
  await provider.setCommitStatus(ref, sha, {
    context: DOCS_STATUS_CONTEXT,
    state: "success",
    description: "Tài liệu đã lưu trên xDev Hive",
    ...(link ? { targetUrl: link } : {}),
  });
  return { head, sha, pr: { ...pr, branch }, docs, assets, skipped, skippedAssets };
}

// ---- Ghi kết quả --------------------------------------------------------------------------------------------------

async function recordSuccess(tx: Tx, deps: PushDeps, plan: PushPlan, out: PushResult): Promise<void> {
  const { home } = plan;
  const direct = home.mode === "direct";
  for (const d of out.docs) {
    const moved = d.from !== d.row.repoPath;
    // Lưu, lưu trữ hoặc di chuyển mới tới giữa lúc ghi thì dòng ở lại `pending` để lô sau đẩy tiếp.
    const unchanged = sql`exists (select 1 from hive.docs where id = ${d.row.docId} and current_version = ${d.version}
      and (archived_at is not null) = ${d.archived}) and ${docRepoFiles.repoPath} = ${d.row.repoPath}`;
    await tx
      .update(docRepoFiles)
      .set({
        syncedVersion: d.version,
        syncedCommit: out.sha,
        syncedHash: d.hash,
        // Chế độ pr: nhánh chính chưa đổi tới khi PR merge (luồng kéo cập nhật); file di chuyển thì nhánh chính chưa
        // có ở đường dẫn mới.
        repoHash: direct ? d.hash : moved ? null : d.row.repoHash,
        error: null,
        state: sql`case when ${unchanged} then 'synced' else 'pending' end`,
        updatedAt: new Date(),
      })
      .where(eq(docRepoFiles.id, d.row.id));
  }
  if (out.assets.length)
    for (const a of out.assets)
      await tx
        .update(docAssets)
        .set({ state: "available", lfs: a.lfs, updatedAt: new Date() })
        .where(and(eq(docAssets.id, a.row.id), eq(docAssets.state, "pending_push")));
  await tx
    .update(docSyncBatches)
    .set({
      state: "done",
      commitSha: out.sha,
      prNumber: out.pr?.number ?? null,
      docVersions: out.docs.map((d) => ({ docId: d.row.docId, version: d.version })),
      assetIds: out.assets.map((a) => a.row.id),
      error: null,
      nextAt: null,
      updatedAt: new Date(),
    })
    .where(eq(docSyncBatches.id, plan.batch.id));
  await tx
    .update(docHomes)
    .set({
      error: null,
      updatedAt: new Date(),
      // Chỉ tiến khi repo không có thay đổi nào hub chưa kéo: luồng kéo so từ `last_commit`, tiến qua thì bỏ sót.
      ...(direct && out.sha && home.lastCommit === out.head ? { lastCommit: out.sha } : {}),
      ...(out.pr ? { prNumber: out.pr.number, prUrl: out.pr.url } : {}),
    })
    .where(eq(docHomes.id, home.id));
  // Nhà tổ chức không có cài đặt merge của dự án: PR chờ người merge (Q1).
  if (out.pr && home.projectId && plan.mergeQueue)
    await enqueueMerge(
      tx,
      {
        projectId: home.projectId,
        prNumber: out.pr.number,
        prUrl: out.pr.url,
        branch: out.pr.branch,
        runId: null,
        by: SYSTEM_ACTOR,
      },
      { jobs: deps.jobs },
    );
  if (out.skipped.length || out.skippedAssets.length)
    await enqueuePull(tx, deps.jobs, { orgId: home.orgId, homeId: home.id });
  const [left] = await tx
    .select({ id: docRepoFiles.id })
    .from(docRepoFiles)
    .where(and(eq(docRepoFiles.homeId, home.id), eq(docRepoFiles.state, "pending")))
    .limit(1);
  // Còn file mới lưu giữa lúc ghi (file bị bỏ vì repo đổi chờ luồng kéo, không tính).
  const skippedIds = new Set(out.skipped.map((d) => d.row.id));
  if (left && !skippedIds.has(left.id))
    await enqueuePush(tx, deps.jobs, { orgId: home.orgId, homeId: home.id }, PUSH_DEBOUNCE_MS);
  await recordAudit(tx, {
    action: "doc.sync.push",
    actorUserId: null,
    targetType: "doc_home",
    targetId: home.id,
    data: {
      batchId: plan.batch.id,
      mode: home.mode,
      commit: out.sha,
      prUrl: out.pr?.url ?? null,
      files: out.docs.map((d) => ({ path: d.row.repoPath, version: d.version, deleted: d.content === null })),
      assets: out.assets.map((a) => a.row.repoPath),
      skipped: out.skipped.map((d) => d.row.repoPath),
    },
  });
}

async function recordFailure(tx: Tx, deps: PushDeps, plan: PushPlan, error: unknown): Promise<void> {
  const protectedBranch = error instanceof BranchProtectedError;
  const message = protectedBranch
    ? "Nhánh được bảo vệ, không ghi thẳng được. Hãy chuyển chế độ đồng bộ sang PR."
    : errorText(error);
  const attempt = plan.batch.attempts;
  const scheduled = protectedBranch ? null : retryDelayMs(attempt);
  const retryAfter = isGitProviderError(error) ? (error.retryAfterMs ?? 0) : 0;
  const delay = scheduled === null ? null : Math.max(scheduled, retryAfter);
  await tx
    .update(docSyncBatches)
    .set({
      state: "failed",
      error: protectedBranch ? "DOCSYNC_BRANCH_PROTECTED" : message,
      nextAt: delay === null ? null : new Date(Date.now() + delay),
      updatedAt: new Date(),
    })
    .where(eq(docSyncBatches.id, plan.batch.id));
  const ids = plan.docs.map((d) => d.row.id);
  if (ids.length)
    await tx
      .update(docRepoFiles)
      .set({ state: "failed", error: message, updatedAt: new Date() })
      .where(and(inArray(docRepoFiles.id, ids), inArray(docRepoFiles.state, ["pending", "failed"])));
  await tx.update(docHomes).set({ error: message, updatedAt: new Date() }).where(eq(docHomes.id, plan.home.id));
  if (delay !== null) await enqueuePush(tx, deps.jobs, { orgId: plan.home.orgId, homeId: plan.home.id }, delay);
  await recordAudit(tx, {
    action: "doc.sync.push_fail",
    actorUserId: null,
    targetType: "doc_home",
    targetId: plan.home.id,
    data: { batchId: plan.batch.id, attempt, error: message, retryInMs: delay },
  });
  // Báo khi hết lượt hoặc lỗi không tự hết (FR-015); các lần thử giữa chừng chỉ hiện ở trạng thái nhà.
  if (delay === null) await notifyFailed(tx, deps, plan.home, plan.projectKey, message);
}

async function notifyFailed(tx: Tx, deps: PushDeps, home: Home, projectKey: string | null, error: string) {
  const project = home.projectId ? await loadProject(tx, home.projectId) : null;
  const recipientIds = project ? await teamMemberIds(tx, project.teamId, "admin") : await notificationRecipients(tx);
  if (!recipientIds.length) return;
  await notify(
    tx,
    {
      orgId: home.orgId,
      event: "docsync.sync_failed",
      title: `Chưa đồng bộ được tài liệu vào repo ${home.owner}/${home.name}`,
      body: `${projectKey ? `Dự án ${projectKey}: ` : ""}${error} Sửa quyền hoặc cài đặt rồi bấm “Đồng bộ ngay”.`,
      eventKey: `docsync.sync_failed:${home.id}:${Date.now()}`,
      recipientIds,
      link: deps.publicUrl ? `${deps.publicUrl.replace(/\/+$/, "")}/docs` : null,
    },
    { jobs: deps.jobs },
  );
}

/** Job `docsync-push`: một commit cho mọi file đang chờ của nhà. Lỗi Git ghi vào lô, không ném ra pg-boss. */
export async function pushHome(deps: PushDeps, job: DocSyncPushJob): Promise<PushOutcome> {
  const ctx = { orgId: job.orgId };
  const plan = await withTenant(deps.pool, ctx, (tx) => planPush(tx, deps, job));
  if (typeof plan === "string") return plan;
  let out: PushResult;
  try {
    out = await pushPlan(deps, plan);
  } catch (e) {
    await withTenant(deps.pool, ctx, (tx) => recordFailure(tx, deps, plan, e));
    return "failed";
  }
  await withTenant(deps.pool, ctx, (tx) => recordSuccess(tx, deps, plan, out));
  return out.docs.length || out.assets.length ? "pushed" : "empty";
}

// ---- Đồng bộ ngay, PR bị đóng -------------------------------------------------------------------------------------

/** "Đồng bộ ngay" và "Thử lại": lô lỗi bắt đầu lại lịch thử, file lỗi về `pending`, job chạy ngay. */
export async function requestPushNow(tx: Tx, jobs: Jobs | undefined, home: Home): Promise<boolean> {
  await tx
    .update(docRepoFiles)
    .set({ state: "pending", error: null, updatedAt: new Date() })
    .where(and(eq(docRepoFiles.homeId, home.id), eq(docRepoFiles.state, "failed")));
  await tx
    .update(docSyncBatches)
    .set({ nextAt: null, attempts: 0, updatedAt: new Date() })
    .where(and(eq(docSyncBatches.homeId, home.id), eq(docSyncBatches.state, "failed")));
  await tx.update(docHomes).set({ error: null, updatedAt: new Date() }).where(eq(docHomes.id, home.id));
  const id = await enqueuePush(tx, jobs, { orgId: home.orgId, homeId: home.id, now: true }, 0);
  return id !== null;
}

/**
 * PR đồng bộ bị đóng không merge: file của các lô trong PR về `pending` với hash của nhánh chính, nhà ghi lỗi để người
 * dùng biết. Không tự mở lại tới lần lưu kế tiếp hoặc "Đồng bộ ngay" (plan.md mục 5).
 */
export async function resetClosedPr(tx: Tx, home: Home, prNumber: number): Promise<number> {
  const batches = await tx
    .select()
    .from(docSyncBatches)
    .where(and(eq(docSyncBatches.homeId, home.id), eq(docSyncBatches.prNumber, prNumber)));
  const docIds = [...new Set(batches.flatMap((b) => b.docVersions.map((v) => v.docId)))];
  const assetIds = [...new Set(batches.flatMap((b) => b.assetIds))];
  const reset = docIds.length
    ? await tx
        .update(docRepoFiles)
        .set({
          state: "pending",
          syncedHash: sql`${docRepoFiles.repoHash}`,
          error: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(docRepoFiles.homeId, home.id),
            inArray(docRepoFiles.docId, docIds),
            inArray(docRepoFiles.state, ["synced", "pending", "failed"]),
          ),
        )
        .returning({ id: docRepoFiles.id })
    : [];
  if (assetIds.length)
    await tx
      .update(docAssets)
      .set({ state: "pending_push", updatedAt: new Date() })
      .where(and(inArray(docAssets.id, assetIds), eq(docAssets.state, "available")));
  await tx
    .update(docHomes)
    .set({
      prNumber: null,
      prUrl: null,
      firstQueuedAt: null,
      error: "PR đồng bộ tài liệu bị đóng mà không merge. Lưu tài liệu hoặc bấm “Đồng bộ ngay” để mở PR mới.",
      updatedAt: new Date(),
    })
    .where(and(eq(docHomes.id, home.id), eq(docHomes.prNumber, prNumber)));
  await recordAudit(tx, {
    action: "doc.sync.pr_closed",
    actorUserId: null,
    targetType: "doc_home",
    targetId: home.id,
    data: { prNumber, files: reset.length, assets: assetIds.length },
  });
  return reset.length;
}

export async function onDocsPrClosed(event: PullRequestEvent, ctx: ScmEventContext): Promise<void> {
  if (event.kind !== "pull_request.closed") return;
  const [home] = await ctx.tx
    .select()
    .from(docHomes)
    .where(and(eq(docHomes.projectId, ctx.projectId), eq(docHomes.prNumber, event.pullRequest.number)));
  if (!home || event.pullRequest.head !== syncBranchName(await projectKeyOf(ctx.tx, home))) return;
  await resetClosedPr(ctx.tx, home, event.pullRequest.number);
}

export async function registerPush(jobs: Jobs, deps: DocSyncDeps): Promise<void> {
  // Không có database thì không có gì để đẩy (test khung đăng ký gọi với deps rỗng).
  const { pool } = deps;
  if (!pool) return;
  provideDocSaved(docSavedHandler(deps.jobs ?? jobs));
  const full: PushDeps = { ...deps, jobs: deps.jobs ?? jobs, pool };
  await jobs.work<DocSyncPushJob>(PUSH_QUEUE, async ({ data }) => {
    await pushHome(full, data);
  });
  onScmEvent("pull_request.closed", onDocsPrClosed);
}
