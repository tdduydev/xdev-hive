import { mergeBlocks, scanSecrets } from "@xdev-hive/contracts";
import { and, eq, sql } from "drizzle-orm";
import type pg from "pg";
import { loadProject, type ProjectRow } from "../catalog/index.ts";
import { docContentHash, type Principal, proposeDoc, saveDocFromSync, startReview } from "../knowledge/index.ts";
import { notify } from "../notify/index.ts";
import { createPostgresBlobStore, detectMediaType, type Jobs, type Tx, withTenant } from "../platform/index.ts";
import {
  type CommitChange,
  type GitProvider,
  isGitProviderError,
  onScmEvent,
  type PushEvent,
  type RepoInfo,
  type ScmEventContext,
} from "../scm/index.ts";
import { sdlcManagedPaths } from "../sdlc/index.ts";
import { teamMemberIds } from "../tenancy/index.ts";
import { contentHash, detectEol, hasBom, parseFrontMatter, titleOf, toLf } from "./content.ts";
import { type HomeRow, homeProvider } from "./homes.ts";
import { DOCSYNC_PULL_QUEUE, type DocSyncHomeJob, queuePull, queuePush } from "./jobs.ts";
import { keyFromPath, type ManagedPaths, matchesHome, type PathHome, uniqueKey } from "./paths.ts";
import { matchRenames, type RenameFile } from "./renames.ts";
import type { DocSyncDeps } from "./routes/deps.ts";
import { docAssets, docConflicts, docHomes, docRepoFiles } from "./schema.ts";

export const DOCSYNC_PULL_CRON = "*/15 * * * *";
export type DocSyncPullJob = DocSyncHomeJob | { scan: true };

type FileRow = typeof docRepoFiles.$inferSelect;
type AssetRow = typeof docAssets.$inferSelect;
type PullDeps = DocSyncDeps & { pool: pg.Pool };
type Outcome = "applied" | "merged" | "conflict" | "proposed" | "skipped" | "deleted" | "created" | "failed";

export interface PullResult {
  head: string | null;
  /** Số file theo kết quả; `renamed` đếm riêng vì file đổi tên còn có thể đổi nội dung. */
  counts: Partial<Record<Outcome | "renamed", number>>;
  status: "synced" | "unchanged" | "paused" | "error" | "inactive";
}

interface Loaded {
  home: HomeRow;
  project: ProjectRow | null;
  provider: GitProvider;
  pathHome: PathHome;
  managed: ManagedPaths;
  files: FileRow[];
  assets: AssetRow[];
}

/** Nội dung repo của một file: bản gốc để tính hash như repo, bản LF để lưu như hub. */
interface RepoFile {
  path: string;
  raw: string;
  bytes?: Uint8Array;
}

const short = (sha: string) => sha.slice(0, 12);
const isMarkdown = (path: string) => /\.md$/i.test(path);
const accessLost = (e: unknown) =>
  isGitProviderError(e, "unauthorized") || isGitProviderError(e, "forbidden") || isGitProviderError(e, "not_found");
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---- Kích hoạt ------------------------------------------------------------------------------------------------------

/** Push vào nhánh của nhà dự án: chỉ xếp job (gom 30 giây), không gọi provider trong transaction của webhook. */
export async function onDocsPush(event: PushEvent, ctx: ScmEventContext, jobs: Jobs | undefined): Promise<void> {
  if (!jobs) return;
  const [home] = await ctx.tx.select().from(docHomes).where(eq(docHomes.projectId, ctx.projectId));
  if (home?.status !== "active" || home.mode === "off" || event.branch !== home.branch) return;
  await queuePull(jobs, { orgId: ctx.orgId, homeId: home.id }, { tx: ctx.tx });
}

/**
 * Cron: xếp lần kéo cho mọi nhà đang chạy. Job tự dừng sớm khi `branchHead` trùng `last_commit`, nên nhà có webhook
 * chỉ tốn hai lời gọi; đổi lại phát hiện được nhánh mặc định đổi và webhook bị mất.
 */
export async function scanHomes(deps: PullDeps): Promise<number> {
  if (!deps.jobs) return 0;
  const jobs = deps.jobs;
  const orgs = await withTenant(deps.pool, {}, async (tx) => {
    const { rows } = await tx.execute<{ org_id: string }>(sql`select org_id from hive.docsync_active_orgs()`);
    return rows.map((r) => r.org_id);
  });
  let queued = 0;
  for (const orgId of orgs)
    await withTenant(deps.pool, { orgId }, async (tx) => {
      const homes = await tx
        .select({ id: docHomes.id, mode: docHomes.mode })
        .from(docHomes)
        .where(eq(docHomes.status, "active"));
      for (const home of homes) {
        if (home.mode === "off") continue;
        await queuePull(jobs, { orgId, homeId: home.id }, { tx });
        queued += 1;
      }
    });
  return queued;
}

export async function registerPull(jobs: Jobs, deps: DocSyncDeps): Promise<void> {
  const { pool } = deps;
  if (!pool) return;
  const full: PullDeps = { ...deps, pool, jobs };
  await jobs.work<DocSyncPullJob>(DOCSYNC_PULL_QUEUE, async ({ data }) => {
    if ("scan" in data) await scanHomes(full);
    else await pullHome(full, data);
  });
  await jobs.schedule(DOCSYNC_PULL_QUEUE, DOCSYNC_PULL_CRON, { scan: true } satisfies DocSyncPullJob);
  onScmEvent("push", (event, ctx) => onDocsPush(event, ctx, jobs));
}

// ---- Một lần kéo -------------------------------------------------------------------------------------------------

async function load(tx: Tx, deps: PullDeps, homeId: string): Promise<Loaded | null> {
  const [home] = await tx.select().from(docHomes).where(eq(docHomes.id, homeId));
  if (home?.status !== "active" || home.mode === "off") return null;
  const project = home.projectId ? await loadProject(tx, home.projectId) : null;
  if (home.projectId && !project) return null;
  // Cột lưu `{}` khi chưa cấu hình; mảng rỗng phải về mẫu mặc định, không phải "không lấy file nào".
  const patterns = {
    root: home.root,
    ...(home.include.length ? { include: home.include } : {}),
    ...(home.exclude.length ? { exclude: home.exclude } : {}),
  };
  const pathHome: PathHome = project
    ? { scope: "project", projectKey: project.key, ...patterns }
    : { scope: "org", ...patterns };
  return {
    home,
    project,
    provider: await homeProvider(tx, deps, home.connectionId),
    pathHome,
    managed: project ? { sdlcPaths: await sdlcManagedPaths(tx, project.id) } : {},
    files: await tx.select().from(docRepoFiles).where(eq(docRepoFiles.homeId, homeId)),
    assets: await tx.select().from(docAssets).where(eq(docAssets.homeId, homeId)),
  };
}

/**
 * Job `docsync-pull` của một nhà (plan.md mục 6). Gọi provider ngoài transaction, rồi ghi từng file trong transaction
 * riêng: một file lỗi không chặn file khác, và `last_commit` chỉ tiến khi mọi file đã xong để lần sau thử lại.
 */
export async function pullHome(deps: PullDeps, job: DocSyncHomeJob): Promise<PullResult> {
  const { orgId, homeId } = job;
  const loaded = await withTenant(deps.pool, { orgId }, (tx) => load(tx, deps, homeId));
  if (!loaded) return { head: null, counts: {}, status: "inactive" };
  const { home, provider } = loaded;
  const ref = { owner: home.owner, name: home.name };

  let repo: RepoInfo | null;
  let head: string | null;
  try {
    // Một lời gọi thêm mỗi lần kéo để thấy nhánh mặc định đổi và repo đổi tên/chuyển chủ (spec Edge Cases).
    repo = await provider.getRepo(ref);
    head = repo && repo.defaultBranch === home.branch ? await provider.branchHead(ref, home.branch) : null;
  } catch (e) {
    if (!accessLost(e)) throw e;
    repo = null;
    head = null;
  }
  if (!repo || (repo.defaultBranch === home.branch && !head)) {
    await stopHome(deps, loaded, "error", "no_access", "Kết nối Git không còn quyền đọc repo tài liệu.");
    return { head: null, counts: {}, status: "error" };
  }
  if (repo.defaultBranch !== home.branch) {
    await stopHome(
      deps,
      loaded,
      "paused",
      "default_branch_changed",
      `Nhánh mặc định của repo đã đổi từ ${home.branch} sang ${repo.defaultBranch}.`,
    );
    return { head: null, counts: {}, status: "paused" };
  }
  const moved =
    repo.owner.toLowerCase() !== home.owner.toLowerCase() || repo.name.toLowerCase() !== home.name.toLowerCase();
  if (moved || head === home.lastCommit) {
    if (moved)
      await withTenant(deps.pool, { orgId }, (tx) =>
        tx
          .update(docHomes)
          .set({ owner: repo.owner, name: repo.name, updatedAt: new Date() })
          .where(eq(docHomes.id, home.id)),
      );
    if (head === home.lastCommit) return { head, counts: {}, status: "unchanged" };
  }
  const repoRef = { owner: repo.owner, name: repo.name };
  const sha = head as string;
  const plan = await planChanges(loaded, provider, repoRef, sha);

  const counts: PullResult["counts"] = {};
  const count = (k: Outcome | "renamed") => {
    counts[k] = (counts[k] ?? 0) + 1;
  };
  let ok = true;
  const run = async (path: string, fn: (tx: Tx) => Promise<Outcome>) => {
    try {
      count(await withTenant(deps.pool, { orgId }, fn));
    } catch (e) {
      ok = false;
      count("failed");
      await withTenant(deps.pool, { orgId }, (tx) =>
        tx
          .update(docRepoFiles)
          .set({ state: "failed", error: errorText(e).slice(0, 2000), updatedAt: new Date() })
          .where(and(eq(docRepoFiles.homeId, home.id), eq(docRepoFiles.repoPath, path))),
      );
    }
  };

  for (const r of plan.renames)
    await run(r.from, async (tx) => {
      await tx.update(docRepoFiles).set({ repoPath: r.to, updatedAt: new Date() }).where(eq(docRepoFiles.id, r.row.id));
      count("renamed");
      return r.file ? applyFile(tx, deps, loaded, r.row.id, r.file, sha) : "skipped";
    });
  for (const { row, file } of plan.modified)
    await run(row.repoPath, (tx) => applyFile(tx, deps, loaded, row.id, file, sha));
  for (const row of plan.removed) await run(row.repoPath, (tx) => markDeleted(tx, deps, loaded, row, sha));
  for (const file of plan.added) await run(file.path, (tx) => createDoc(tx, loaded, file, sha));
  for (const { row, file } of plan.assets) await run(row.repoPath, (tx) => updateAsset(tx, deps, row, file));

  if (ok)
    await withTenant(deps.pool, { orgId }, (tx) =>
      tx.update(docHomes).set({ lastCommit: sha, error: null, updatedAt: new Date() }).where(eq(docHomes.id, home.id)),
    );
  return { head: sha, counts, status: "synced" };
}

async function stopHome(
  deps: PullDeps,
  loaded: Loaded,
  status: "paused" | "error",
  reason: string,
  message: string,
): Promise<void> {
  const { home, project } = loaded;
  await withTenant(deps.pool, { orgId: home.orgId }, async (tx) => {
    // Khoá dòng nhà: hai lần kéo song song (cron và webhook) chỉ gửi một thông báo.
    const [row] = await tx.select().from(docHomes).where(eq(docHomes.id, home.id)).for("update");
    if (!row || (row.status === status && row.statusReason === reason)) return;
    await tx
      .update(docHomes)
      .set({ status, statusReason: reason, error: message, updatedAt: new Date() })
      .where(eq(docHomes.id, home.id));
    await notify(
      tx,
      {
        orgId: home.orgId,
        event: status === "paused" ? "docsync.paused" : "docsync.sync_failed",
        title: status === "paused" ? "Đồng bộ tài liệu đã tạm dừng" : "Đồng bộ tài liệu lỗi quyền",
        body: `${home.owner}/${home.name}: ${message}`,
        eventKey: `docsync.${reason}:${home.id}:${home.branch}`,
        recipientIds: project ? await teamMemberIds(tx, project.teamId, "admin") : undefined,
      },
      { jobs: deps.jobs },
    );
  });
}

// ---- Tìm thay đổi -------------------------------------------------------------------------------------------------

interface Plan {
  renames: { from: string; to: string; row: FileRow; file: RepoFile | null }[];
  modified: { row: FileRow; file: RepoFile }[];
  removed: FileRow[];
  added: RepoFile[];
  assets: { row: AssetRow; file: RepoFile }[];
}

/**
 * Danh sách thay đổi: `compare(last_commit, head)`, hoặc so cây ở head với các file đã ánh xạ khi chưa có
 * `last_commit` (vừa nhận nhánh mới) hay provider báo kết quả thiếu.
 */
async function changesOf(
  loaded: Loaded,
  provider: GitProvider,
  ref: { owner: string; name: string },
  head: string,
): Promise<CommitChange[]> {
  const { home, files, assets } = loaded;
  if (home.lastCommit) {
    try {
      const diff = await provider.compare(ref, home.lastCommit, head);
      if (!diff.incomplete) return diff.files;
    } catch (e) {
      // Commit cũ bị force-push xoá thì không so được nữa; so cây vẫn cho kết quả đúng.
      if (!isGitProviderError(e, "not_found")) throw e;
    }
  }
  const present = new Set(await provider.listFiles(ref, head));
  const tracked = new Set([...files.map((f) => f.repoPath), ...assets.map((a) => a.repoPath)]);
  const changes: CommitChange[] = [];
  for (const path of present) changes.push({ path, status: tracked.has(path) ? "modified" : "added", sha: null });
  // Dòng chưa từng lên repo (tài liệu hub chờ đẩy) không phải file bị xoá.
  for (const f of files)
    if (!present.has(f.repoPath) && f.repoHash !== null)
      changes.push({ path: f.repoPath, status: "removed", sha: null });
  return changes;
}

async function planChanges(
  loaded: Loaded,
  provider: GitProvider,
  ref: { owner: string; name: string },
  head: string,
): Promise<Plan> {
  const { home, files, assets, pathHome, managed } = loaded;
  const byPath = new Map(files.map((f) => [f.repoPath, f]));
  const assetByPath = new Map(assets.map((a) => [a.repoPath, a]));
  const read = async (path: string, sha: string | null): Promise<RepoFile | null> => {
    const raw = await provider.readFile(ref, path, head);
    if (raw === null) return null;
    return { path, raw, ...(sha && assetByPath.has(path) ? { bytes: await provider.readBlob(ref, sha) } : {}) };
  };
  const plan: Plan = { renames: [], modified: [], removed: [], added: [], assets: [] };
  const removed: FileRow[] = [];
  const added: RepoFile[] = [];
  const addable = (path: string) =>
    isMarkdown(path) &&
    !byPath.has(path) &&
    matchesHome(path, pathHome, managed) &&
    keyFromPath(path, pathHome) !== null;

  for (const change of await changesOf(loaded, provider, ref, head)) {
    const row = byPath.get(change.path);
    if (change.status === "renamed" && change.previousPath) {
      const old = byPath.get(change.previousPath);
      if (old && old.state !== "excluded" && !byPath.has(change.path)) {
        plan.renames.push({ from: old.repoPath, to: change.path, row: old, file: await read(change.path, change.sha) });
        continue;
      }
      // Đổi tên không ghép được (file cũ không quản lý hoặc đích đã có chủ): một file mất và một file mới.
      if (old && old.state !== "excluded") removed.push(old);
      if (addable(change.path)) {
        const file = await read(change.path, change.sha);
        if (file) added.push(file);
      }
      continue;
    }
    const asset = assetByPath.get(change.path);
    if (asset) {
      if (change.status === "removed") continue;
      const file = await read(change.path, change.sha);
      if (file) plan.assets.push({ row: asset, file });
      continue;
    }
    if (row?.state === "excluded") continue;
    if (change.status === "removed") {
      // Trước khi đánh dấu xoá thì đọc lại: listFiles của provider có thể bị cắt bớt với cây lớn.
      if (row && row.state !== "deleted_in_repo" && (await provider.readFile(ref, row.repoPath, head)) === null)
        removed.push(row);
      continue;
    }
    if (row) {
      const file = await read(change.path, change.sha);
      if (file) plan.modified.push({ row, file });
      else if (row.state !== "deleted_in_repo" && row.repoHash !== null) removed.push(row);
    } else if (addable(change.path)) {
      const file = await read(change.path, change.sha);
      if (file) added.push(file);
    }
  }

  // Ghép đổi tên còn lại theo hash nội dung rồi độ giống khối (research.md mục 3.2).
  if (removed.length && added.length) {
    const before = await Promise.all(
      removed.map(async (row): Promise<RenameFile> => {
        const old = home.lastCommit
          ? await provider.readFile(ref, row.repoPath, home.lastCommit).catch(() => null)
          : null;
        return {
          path: row.repoPath,
          ...(row.repoHash ? { blobSha: row.repoHash } : {}),
          ...(old ? { content: toLf(old) } : {}),
        };
      }),
    );
    const after = added.map((f) => ({ path: f.path, blobSha: contentHash(f.raw), content: toLf(f.raw) }));
    for (const m of matchRenames(before, after)) {
      const row = removed.find((r) => r.repoPath === m.from);
      const file = added.find((f) => f.path === m.to);
      if (!row || !file) continue;
      plan.renames.push({ from: m.from, to: m.to, row, file });
      removed.splice(removed.indexOf(row), 1);
      added.splice(added.indexOf(file), 1);
    }
  }
  plan.removed = removed;
  plan.added = added;
  return plan;
}

// ---- Từng file ----------------------------------------------------------------------------------------------------

interface DocState {
  id: string;
  key: string;
  title: string;
  teamId: string | null;
  projectId: string | null;
  version: number;
  archived: boolean;
  content: string;
  base: string | null;
}

/**
 * Đọc thẳng bảng của knowledge vì job không có người dùng để gọi `getDoc`; chỉ đọc, mọi ghi vẫn qua API public.
 * Khoá dòng tài liệu để lưu trên hub cùng lúc không chen giữa lúc đọc và lúc ghi phiên bản.
 */
async function docState(tx: Tx, docId: string, syncedVersion: number | null): Promise<DocState | null> {
  const { rows } = await tx.execute<{
    id: string;
    key: string;
    title: string;
    team_id: string | null;
    project_id: string | null;
    current_version: number;
    archived_at: Date | null;
    content: string;
    base: string | null;
  }>(sql`
    select d.id, d.key, d.title, d.team_id, d.project_id, d.current_version, d.archived_at, cur.content,
      base.content as base
    from hive.docs d
    join hive.doc_versions cur on cur.doc_id = d.id and cur.version = d.current_version
    left join hive.doc_versions base on base.doc_id = d.id and base.version = ${syncedVersion ?? -1}
    where d.id = ${docId}
    for update of d`);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    key: r.key,
    title: r.title,
    teamId: r.team_id,
    projectId: r.project_id,
    version: r.current_version,
    archived: r.archived_at !== null,
    content: r.content,
    base: r.base,
  };
}

/** Phiên bản hub (từ lần đồng bộ cuối trở đi) có đúng nội dung này: commit do chính hub đẩy lên. */
async function hubVersionWith(tx: Tx, docId: string, from: number | null, lf: string): Promise<number | null> {
  const { rows } = await tx.execute<{ version: number | null }>(sql`
    select max(version) as version from hive.doc_versions
    where doc_id = ${docId} and version >= ${from ?? 0} and content_hash = ${docContentHash(lf)}`);
  return rows[0]?.version ?? null;
}

async function recipients(tx: Tx, loaded: Loaded, teamId: string | null): Promise<string[] | undefined> {
  const team = loaded.project?.teamId ?? teamId;
  return team ? teamMemberIds(tx, team, "admin") : undefined;
}

async function applyFile(
  tx: Tx,
  deps: PullDeps,
  loaded: Loaded,
  fileId: string,
  file: RepoFile,
  head: string,
): Promise<Outcome> {
  const [row] = await tx.select().from(docRepoFiles).where(eq(docRepoFiles.id, fileId)).for("update");
  if (!row) return "skipped";
  const hash = contentHash(file.raw);
  const lf = toLf(file.raw);
  const format = { eol: detectEol(file.raw), bom: hasBom(file.raw) };
  const now = new Date();
  // Đã xử lý đúng bản này (job chạy lại, hoặc webhook đến trước khi lần đẩy kịp ghi commit).
  if (row.repoHash === hash && row.state !== "deleted_in_repo") return "skipped";
  const doc = await docState(tx, row.docId, row.syncedVersion);
  if (!doc || doc.archived) return "skipped";

  const own = await hubVersionWith(tx, doc.id, row.syncedVersion, lf);
  if (own !== null) {
    await tx
      .update(docRepoFiles)
      .set({
        ...format,
        syncedVersion: own,
        syncedCommit: head,
        syncedHash: hash,
        repoHash: hash,
        state: own === doc.version ? "synced" : "pending",
        error: null,
        updatedAt: now,
      })
      .where(eq(docRepoFiles.id, row.id));
    // Repo đã về đúng bản hub: xung đột cũ không còn ý nghĩa.
    await tx
      .update(docConflicts)
      .set({ state: "resolved", resolution: "hub", resolvedVersion: own, hubVersion: doc.version, updatedAt: now })
      .where(and(eq(docConflicts.docId, doc.id), eq(docConflicts.state, "open")));
    return "skipped";
  }

  const [openConflict] = await tx
    .select({ id: docConflicts.id })
    .from(docConflicts)
    .where(and(eq(docConflicts.docId, doc.id), eq(docConflicts.state, "open")));
  const hubChanged = doc.version !== row.syncedVersion || Boolean(openConflict);
  const secret = scanSecrets(lf).length > 0;
  const message = `Cập nhật từ repo, commit ${short(head)}.`;

  if (!hubChanged && loaded.home.repoChangesNeedReview && !secret) {
    await propose(tx, deps, loaded.home, doc, lf, head);
    // Bản gốc chung giữ nguyên tới khi đề xuất được duyệt; lô đẩy không ghi đè repo trong lúc chờ.
    await tx
      .update(docRepoFiles)
      .set({ ...format, repoHash: hash, error: null, updatedAt: now })
      .where(eq(docRepoFiles.id, row.id));
    return "proposed";
  }

  if (!hubChanged) {
    const saved = await saveDocFromSync(tx, {
      key: doc.key,
      title: titleOf(lf, file.path),
      content: lf,
      baseVersion: doc.version,
      scope: { teamId: doc.teamId, projectId: doc.projectId },
      source: "repo",
      repoCommit: head,
      message,
    });
    await tx
      .update(docRepoFiles)
      .set({
        ...format,
        syncedVersion: saved.version,
        syncedCommit: head,
        syncedHash: hash,
        repoHash: hash,
        state: saved.secretFlag ? "blocked_secret" : "synced",
        error: null,
        updatedAt: now,
      })
      .where(eq(docRepoFiles.id, row.id));
    return "applied";
  }

  const merged = mergeBlocks(doc.base ?? "", doc.content, lf);
  if (merged.conflicts === 0) {
    const saved = await saveDocFromSync(tx, {
      key: doc.key,
      content: merged.content,
      baseVersion: doc.version,
      scope: { teamId: doc.teamId, projectId: doc.projectId },
      source: "merge",
      repoCommit: head,
      message: `Hợp thay đổi từ repo, commit ${short(head)}.`,
    });
    // Như giải quyết xung đột: bản repo thành gốc chung mới, bản hợp chờ lô đẩy kế tiếp.
    await tx
      .update(docRepoFiles)
      .set({
        ...format,
        syncedCommit: head,
        syncedHash: hash,
        repoHash: hash,
        state: saved.secretFlag ? "blocked_secret" : "pending",
        error: null,
        updatedAt: now,
      })
      .where(eq(docRepoFiles.id, row.id));
    if (!saved.secretFlag && deps.jobs) await queuePush(deps.jobs, { orgId: row.orgId, homeId: row.homeId }, { tx });
    return "merged";
  }

  // Một tài liệu chỉ có một xung đột mở: thay đổi repo mới cập nhật xung đột đó (US3 kịch bản 4).
  if (openConflict)
    await tx
      .update(docConflicts)
      .set({ repoContent: lf, repoCommit: head, hubVersion: doc.version, updatedAt: now })
      .where(eq(docConflicts.id, openConflict.id));
  else
    await tx.insert(docConflicts).values({
      orgId: row.orgId,
      homeId: row.homeId,
      docId: doc.id,
      baseVersion: row.syncedVersion ?? 0,
      hubVersion: doc.version,
      repoCommit: head,
      repoContent: lf,
    });
  await tx
    .update(docRepoFiles)
    .set({ ...format, repoHash: hash, state: "conflict", error: null, updatedAt: now })
    .where(eq(docRepoFiles.id, row.id));
  if (!openConflict)
    await notify(
      tx,
      {
        orgId: row.orgId,
        event: "docsync.conflict",
        title: "Xung đột đồng bộ tài liệu",
        body: `Tài liệu ${doc.key} vừa đổi cả trên hub và trong repo (${file.path}). Hãy chọn bản giữ lại.`,
        eventKey: `docsync.conflict:${doc.id}:${head}`,
        recipientIds: await recipients(tx, loaded, doc.teamId),
      },
      { jobs: deps.jobs },
    );
  return "conflict";
}

/**
 * Đề xuất thay vì lưu thẳng (`repoChangesNeedReview`), như `proposeFromRepo` của sdlc. Người đề xuất là người cấu
 * hình nhà, vì job không có người dùng và đề xuất cần một thành viên có quyền `propose`.
 */
async function propose(tx: Tx, deps: PullDeps, home: HomeRow, doc: DocState, lf: string, head: string) {
  const principal: Principal = { kind: "user", userId: home.configuredBy };
  await tx.execute(sql`savepoint docsync_repo_proposal`);
  try {
    const proposal = await proposeDoc(tx, principal, {
      key: doc.key,
      title: doc.title,
      content: lf,
      baseVersion: doc.version,
      reason: `Thay đổi từ repo ${home.owner}/${home.name}, commit ${short(head)}.`,
    });
    await startReview(tx, proposal.id, { jobs: deps.jobs, publicUrl: deps.publicUrl });
    await tx.execute(sql`release savepoint docsync_repo_proposal`);
  } catch (e) {
    await tx.execute(sql`rollback to savepoint docsync_repo_proposal`);
    await tx.execute(sql`release savepoint docsync_repo_proposal`);
    throw new Error(`Không tạo được đề xuất từ repo: ${errorText(e)}`);
  }
}

async function markDeleted(tx: Tx, deps: PullDeps, loaded: Loaded, file: FileRow, head: string): Promise<Outcome> {
  const [row] = await tx.select().from(docRepoFiles).where(eq(docRepoFiles.id, file.id)).for("update");
  if (!row || row.state === "deleted_in_repo" || row.state === "excluded") return "skipped";
  const doc = await docState(tx, row.docId, null);
  // Tài liệu đã lưu trữ trên hub: repo xoá file là đúng ý, không cần hỏi.
  if (!doc || doc.archived) return "skipped";
  await tx
    .update(docRepoFiles)
    .set({ state: "deleted_in_repo", syncedCommit: head, error: null, updatedAt: new Date() })
    .where(eq(docRepoFiles.id, row.id));
  await notify(
    tx,
    {
      orgId: row.orgId,
      event: "docsync.deleted_in_repo",
      title: "Tài liệu đã bị xoá trên repo",
      body: `File ${row.repoPath} của tài liệu ${doc.key} đã bị xoá trong repo. Hãy chọn lưu trữ tài liệu hoặc ghi lại vào repo.`,
      eventKey: `docsync.deleted_in_repo:${doc.id}:${head}`,
      recipientIds: await recipients(tx, loaded, doc.teamId),
    },
    { jobs: deps.jobs },
  );
  return "deleted";
}

async function scopeOfKey(
  tx: Tx,
  loaded: Loaded,
  key: string,
): Promise<{ teamId: string | null; projectId: string | null }> {
  if (loaded.project) return { teamId: loaded.project.teamId, projectId: loaded.project.id };
  const [level, slug] = key.split("/");
  if (level !== "team") return { teamId: null, projectId: null };
  const { rows } = await tx.execute<{ id: string }>(sql`select id from hive.teams where slug = ${slug ?? ""}`);
  const team = rows[0];
  if (!team) throw new Error(`Không tìm thấy đội "${slug}" cho file mới trong repo.`);
  return { teamId: team.id, projectId: null };
}

/** File markdown mới khớp mẫu của nhà: tạo tài liệu nguồn `repo` (US3 kịch bản 7). */
async function createDoc(tx: Tx, loaded: Loaded, file: RepoFile, head: string): Promise<Outcome> {
  const { home, pathHome } = loaded;
  const [taken] = await tx
    .select({ id: docRepoFiles.id })
    .from(docRepoFiles)
    .where(and(eq(docRepoFiles.homeId, home.id), eq(docRepoFiles.repoPath, file.path)));
  if (taken) return "skipped";
  const lf = toLf(file.raw);
  const wanted = keyFromPath(file.path, pathHome, parseFrontMatter(lf).key);
  if (!wanted) return "skipped";
  // Key đã có trên hub (tài liệu khác, kể cả đã lưu trữ) thì thêm hậu tố, không ghi đè tài liệu người khác.
  const prefix = wanted.replace(/[^/]*$/, "");
  const { rows } = await tx.execute<{ key: string }>(
    sql`select key from hive.docs where key like ${`${prefix.replace(/[\\%_]/g, "\\$&")}%`}`,
  );
  const key = uniqueKey(wanted, new Set(rows.map((r) => r.key)));
  const saved = await saveDocFromSync(tx, {
    key,
    title: titleOf(lf, file.path),
    content: lf,
    baseVersion: 0,
    scope: await scopeOfKey(tx, loaded, key),
    source: "repo",
    repoCommit: head,
    message: `Tạo từ repo, commit ${short(head)}.`,
  });
  const hash = contentHash(file.raw);
  await tx.insert(docRepoFiles).values({
    orgId: home.orgId,
    homeId: home.id,
    docId: saved.id,
    repoPath: file.path,
    syncedVersion: saved.version,
    syncedCommit: head,
    syncedHash: hash,
    repoHash: hash,
    state: saved.secretFlag ? "blocked_secret" : "synced",
    eol: detectEol(file.raw),
    bom: hasBom(file.raw),
  });
  return "created";
}

/** Đính kèm đã quản lý đổi trong repo: lưu bản mới vào kho file. Đính kèm mới và LFS do luồng đính kèm (T016) lo. */
async function updateAsset(tx: Tx, deps: PullDeps, row: AssetRow, file: RepoFile): Promise<Outcome> {
  const bytes = file.bytes ?? new TextEncoder().encode(file.raw);
  const sha256 = contentHash(bytes);
  if (sha256 === row.sha256 || row.lfs) return "skipped";
  const mediaType = detectMediaType(bytes) ?? row.mediaType;
  const blob = await createPostgresBlobStore(deps.jobs ? { jobs: deps.jobs } : {}).put(
    tx,
    row.orgId,
    (async function* () {
      yield bytes;
    })(),
    mediaType,
    { filename: row.repoPath.split("/").at(-1) ?? row.repoPath },
  );
  await tx
    .update(docAssets)
    .set({ blobId: blob.id, size: bytes.byteLength, sha256, mediaType, state: "available", updatedAt: new Date() })
    .where(eq(docAssets.id, row.id));
  return "applied";
}
