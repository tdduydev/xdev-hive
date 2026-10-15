import type { DocTreeItem } from "@xdev-hive/contracts";
import { and, eq, sql } from "drizzle-orm";
import { recordAudit } from "../../audit/index.ts";
import { findProject } from "../../catalog/index.ts";
import { readerFor } from "../../knowledge/index.ts";
import { BadRequestError, ConflictError, NotFoundError, type Tx } from "../../platform/index.ts";
import { requireOrgRole } from "../../tenancy/index.ts";
import { type HomeRow, homeById } from "../homes.ts";
import { keyFromPath, matchesHome } from "../paths.ts";
import {
  MOVE_ACTION,
  moveOrigin,
  pathHomeOf,
  projectKeyOf,
  queueHomePush,
  REQUEUE_STATES,
  uuidArray,
} from "../push.ts";
import { docAssets, docHomes, docRepoFiles } from "../schema.ts";
import { type DocSyncRouteDeps, docSyncApi } from "./common.ts";
import { requireHomeManage, requireHomeRead } from "./sync.ts";

const SHA = /^[0-9a-f]{40,64}$/;

type TreeRow = {
  home_id: string;
  path: string;
  key: string | null;
  title: string | null;
  kind: "doc" | "asset";
  state: string;
  synced_commit: string | null;
  synced_hash: string | null;
  repo_hash: string | null;
  doc_id: string | null;
  asset_id: string | null;
  version: number | null;
  error: string | null;
};

type Repo = { kind: string; baseUrl: string | null };

/** URL trang file trên GitHub/GitLab để giao diện mở thẳng; không đoán được máy chủ thì null. */
export function repoFileUrl(repo: Repo | undefined, home: HomeRow, path: string): string | null {
  if (!repo) return null;
  const file = path.split("/").map(encodeURIComponent).join("/");
  const branch = home.branch.split("/").map(encodeURIComponent).join("/");
  if (repo.kind === "gitlab") {
    const base = (repo.baseUrl ?? "https://gitlab.com").replace(/\/+$/, "");
    return `${base}/${home.owner}/${home.name}/-/blob/${branch}/${file}`;
  }
  // base_url của GitHub là địa chỉ API (Enterprise: https://host/api/v3), trang web nằm ở gốc máy chủ.
  const base = repo.baseUrl ? repo.baseUrl.replace(/\/+$/, "").replace(/\/api\/v3$/, "") : "https://github.com";
  return `${base}/${home.owner}/${home.name}/blob/${branch}/${file}`;
}

async function reposOf(tx: Tx, homes: HomeRow[]): Promise<Map<string, Repo>> {
  if (!homes.length) return new Map();
  const { rows } = await tx.execute<{ id: string; kind: string; base_url: string | null }>(sql`
    select id, kind::text as kind, base_url from hive.scm_connections
     where id = any(${uuidArray([...new Set(homes.map((h) => h.connectionId))])})
  `);
  return new Map(rows.map((r) => [r.id, { kind: r.kind, baseUrl: r.base_url }]));
}

function treeItem(row: TreeRow, home: HomeRow, repo: Repo | undefined): DocTreeItem {
  // File đã đẩy vào PR mà nhánh chính chưa có thì đang chờ PR đang mở của nhà.
  const inPr =
    home.mode === "pr" && home.prNumber !== null && row.synced_commit !== null && row.synced_hash !== row.repo_hash;
  return {
    homeId: home.id,
    path: row.path,
    key: row.key,
    title: row.title ?? row.path.split("/").at(-1) ?? row.path,
    kind: row.kind,
    state: row.state as DocTreeItem["state"],
    prNumber: inPr ? home.prNumber : null,
    prUrl: inPr ? home.prUrl : null,
    repoUrl: repoFileUrl(repo, home, row.path),
    repoCommit: row.synced_commit && SHA.test(row.synced_commit) ? row.synced_commit : null,
    docId: row.doc_id,
    assetId: row.asset_id,
    version: row.version,
    error: row.error,
  };
}

/** Nhà người gọi đọc được: nhà tổ chức cho mọi thành viên, nhà dự án cho thành viên đội của dự án. */
async function readableHomes(
  tx: Tx,
  userId: string,
  input: { homeId?: string | undefined; project?: string | undefined },
) {
  if (input.homeId) {
    const home = await homeById(tx, input.homeId);
    await requireHomeRead(tx, userId, home);
    return [home];
  }
  await requireOrgRole(tx, userId, "member");
  if (input.project) {
    const project = await findProject(tx, input.project);
    const [home] = project ? await tx.select().from(docHomes).where(eq(docHomes.projectId, project.id)) : [];
    if (!home) throw new NotFoundError("DOCSYNC_HOME_NOT_FOUND", "Không tìm thấy nhà tài liệu trong tổ chức.");
    await requireHomeRead(tx, userId, home);
    return [home];
  }
  const homes: HomeRow[] = [];
  for (const home of await tx.select().from(docHomes)) {
    try {
      await requireHomeRead(tx, userId, home);
      homes.push(home);
    } catch {
      // Nhà dự án của đội khác: bỏ qua, không lộ là có.
    }
  }
  return homes;
}

const encodeCursor = (homeId: string, path: string) =>
  Buffer.from(JSON.stringify([homeId, path])).toString("base64url");

function decodeCursor(cursor: string): [string, string] {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "string")
      return [value[0], value[1]];
  } catch {}
  throw new BadRequestError("INVALID_CURSOR", "Con trỏ phân trang không hợp lệ.");
}

export async function listTree(
  tx: Tx,
  userId: string,
  input: {
    homeId?: string | undefined;
    project?: string | undefined;
    prefix?: string | undefined;
    state?: string | undefined;
    cursor?: string | undefined;
    limit: number;
  },
) {
  const homes = await readableHomes(tx, userId, input);
  if (!homes.length) return { items: [], nextCursor: null };
  const reader = await readerFor(tx, { kind: "user", userId });
  const teamIds = reader.kind === "user" ? [...reader.teams.keys()] : [];
  const after = input.cursor ? decodeCursor(input.cursor) : null;
  const prefix = input.prefix ? `${input.prefix.replace(/[\\%_]/g, "\\$&")}%` : null;
  // Tài liệu của đội khác ẩn như ở knowledge; đính kèm theo tài liệu sở hữu nó.
  const visible = (column: string) =>
    sql`(${sql.raw(column)} is null or ${sql.raw(column)} = any(${uuidArray(teamIds)}))`;
  const assets = input.state
    ? sql``
    : sql`
      union all
      select a.home_id, a.repo_path as path, null as key, null as title, 'asset' as kind, a.state,
             null as synced_commit, null as synced_hash, null as repo_hash, null::uuid as doc_id, a.id as asset_id,
             null::int as version, null as error
        from hive.doc_assets a left join hive.docs o on o.id = a.owner_doc_id
       where ${visible("o.team_id")}`;
  const { rows } = await tx.execute<TreeRow>(sql`
    select * from (
      select f.home_id, f.repo_path as path, d.key, d.title, 'doc' as kind, f.state, f.synced_commit, f.synced_hash,
             f.repo_hash, f.doc_id, null::uuid as asset_id, d.current_version as version, f.error
        from hive.doc_repo_files f join hive.docs d on d.id = f.doc_id
       where d.archived_at is null and ${visible("d.team_id")} ${input.state ? sql`and f.state = ${input.state}` : sql``}
      ${assets}
    ) t
     where t.home_id = any(${uuidArray(homes.map((h) => h.id))})
       ${prefix ? sql`and t.path like ${prefix}` : sql``}
       ${after ? sql`and (t.home_id::text, t.path) > (${after[0]}, ${after[1]})` : sql``}
     order by t.home_id::text, t.path
     limit ${input.limit + 1}
  `);
  const byId = new Map(homes.map((h) => [h.id, h]));
  const repos = await reposOf(tx, homes);
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    items: page.flatMap((r) => {
      const home = byId.get(r.home_id);
      return home ? [treeItem(r, home, repos.get(home.connectionId))] : [];
    }),
    nextCursor: rows.length > input.limit && last ? encodeCursor(last.home_id, last.path) : null,
  };
}

export async function moveDoc(
  tx: Tx,
  deps: Pick<DocSyncRouteDeps, "jobs">,
  userId: string,
  input: { key: string; repoPath: string; baseVersion: number },
): Promise<DocTreeItem> {
  const { rows: found } = await tx.execute<{ id: string; current_version: number }>(sql`
    select id, current_version from hive.docs where key = ${input.key} and archived_at is null
  `);
  const doc = found[0];
  const [row] = doc ? await tx.select().from(docRepoFiles).where(eq(docRepoFiles.docId, doc.id)) : [];
  if (!doc || !row) throw new NotFoundError("DOCSYNC_FILE_NOT_FOUND", "Tài liệu chưa gắn với file trong repo.");
  const home = await homeById(tx, row.homeId);
  await requireHomeManage(tx, userId, home);
  if (doc.current_version !== input.baseVersion)
    throw new ConflictError(
      "VERSION_CONFLICT",
      `Tài liệu đã ở phiên bản ${doc.current_version}, bạn di chuyển từ phiên bản ${input.baseVersion}. Tải lại rồi thử lại.`,
    );
  if (row.state === "conflict")
    throw new ConflictError("DOCSYNC_CONFLICT_OPEN", "Tài liệu còn xung đột cần giải quyết.");
  const pathHome = { ...pathHomeOf(home, await projectKeyOf(tx, home)), include: ["**"], exclude: home.exclude };
  let pinned: string | null;
  try {
    pinned = keyFromPath(input.repoPath, pathHome, input.key);
  } catch {
    pinned = null;
  }
  // Key giữ nguyên nên đường dẫn mới phải còn trong phạm vi của key (đội/tổ chức, dự án) và không bị nhà loại trừ.
  if (pinned !== input.key || !matchesHome(input.repoPath, pathHome))
    throw new BadRequestError("DOCSYNC_PATH_INVALID", "Đường dẫn mới không thuộc nhà tài liệu hoặc bị loại trừ.");
  if (input.repoPath !== row.repoPath) {
    const [takenFile] = await tx
      .select({ id: docRepoFiles.id })
      .from(docRepoFiles)
      .where(and(eq(docRepoFiles.homeId, home.id), eq(docRepoFiles.repoPath, input.repoPath)));
    const [takenAsset] = await tx
      .select({ id: docAssets.id })
      .from(docAssets)
      .where(and(eq(docAssets.homeId, home.id), eq(docAssets.repoPath, input.repoPath)));
    if (takenFile || takenAsset)
      throw new ConflictError("DOCSYNC_PATH_TAKEN", "Đường dẫn đã có file khác trong nhà tài liệu.");
    // Di chuyển nhiều lần trước khi đẩy vẫn tính từ nơi file đang nằm trong repo.
    const from = (await moveOrigin(tx, row)) ?? row.repoPath;
    await tx
      .update(docRepoFiles)
      .set({
        repoPath: input.repoPath,
        ...(REQUEUE_STATES.has(row.state) ? { state: "pending", error: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(docRepoFiles.id, row.id));
    await recordAudit(tx, {
      action: MOVE_ACTION,
      targetType: "doc",
      targetId: doc.id,
      data: { docId: doc.id, key: input.key, from, to: input.repoPath, syncedCommit: row.syncedCommit ?? null },
    });
    if (REQUEUE_STATES.has(row.state)) await queueHomePush(tx, deps.jobs, home);
  }
  const page = await listTree(tx, userId, { homeId: home.id, prefix: input.repoPath, limit: 1 });
  const item = page.items.find((i) => i.path === input.repoPath && i.kind === "doc");
  if (!item) throw new NotFoundError("DOCSYNC_FILE_NOT_FOUND", "Tài liệu chưa gắn với file trong repo.");
  return item;
}

export function treeRoutes(deps: DocSyncRouteDeps) {
  const api = docSyncApi(deps).docTree;
  return {
    list: api.list.handler(({ context, input }) => listTree(context.tx, context.user.id, input)),
    move: api.move.handler(({ context, input }) => moveDoc(context.tx, deps, context.user.id, input)),
  };
}
