import { createHash } from "node:crypto";
import { implement } from "@orpc/server";
import { type ContractFormat, contract, type SdlcArtifactSync, sdlcItemRef } from "@xdev-hive/contracts";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type pg from "pg";
import { recordAudit } from "../audit/index.ts";
import { loadProject, type ProjectRow } from "../catalog/index.ts";
import { authUser } from "../identity/index.ts";
import {
  createProposal,
  docHistory,
  getDoc,
  type Principal,
  type ReviewDeps,
  startReview,
} from "../knowledge/index.ts";
import { notify } from "../notify/index.ts";
import {
  BadRequestError,
  type Jobs,
  type MasterKey,
  type RequestContext,
  type Tx,
  withTenant,
} from "../platform/index.ts";
import {
  type GitProvider,
  loadConnection,
  onScmEvent,
  type ProviderFactory,
  type PushEvent,
  type ScmEventContext,
} from "../scm/index.ts";
import { type OrgDeps, orgMiddlewares, teamMemberIds } from "../tenancy/index.ts";
import { itemForUser, itemViewers, requireProjectWrite } from "./access.ts";
import { artifactViews } from "./artifact-view.ts";
import { sdlcArtifactSyncs, sdlcArtifacts, sdlcItemProjects, sdlcItems } from "./schema.ts";

/*
 * Đồng bộ tài liệu hạng mục giữa hub và repo của từng dự án (specs/011 D11, D12, FR-021–FR-023). Hub giữ bản gốc; repo
 * chỉ nhận baseline. Sửa trong repo không bao giờ thành baseline mà thành đề xuất đi lại cổng. Vòng lặp hub → repo →
 * hub bị chặn bằng hash: nội dung repo bằng hash hub đã ghi hoặc bằng baseline thì bỏ qua.
 */

export const SDLC_SYNC_QUEUE = "sdlc-sync";
export const SDLC_PULL_QUEUE = "sdlc-pull";
export const SDLC_PULL_CRON = "*/15 * * * *";
/** Tác nhân hệ thống của commit đồng bộ và mục hàng merge; như `SDLC_SYSTEM_ACTOR` của phases.ts. */
const SYSTEM_ACTOR = "system:sdlc";
export const SYNC_STATUS_CONTEXT = "xdev-hive/sdlc";
/** Gộp các baseline gần nhau thành một commit mỗi repo (D11), và các push gần nhau thành một lần đọc (D12). */
export const SYNC_DEBOUNCE_MS = 10_000;
export const PULL_DEBOUNCE_MS = 30_000;
/** Thử lại sau 1, 2, 5, 10, 20, 30 phút: tối đa 6 lần trong khoảng một giờ (US4-2). */
export const SYNC_RETRY_MINUTES = [1, 2, 5, 10, 20, 30] as const;
/** Số file đọc mỗi lần quét một dự án; dự án nhiều hơn thì lần quét sau đọc tiếp phần cũ nhất. */
export const PULL_MAX_FILES = 200;

/** Mỗi (hạng mục, dự án) tối đa một job chờ và một job chạy: hai job cùng ghi một nhánh sẽ tạo hai commit chồng nhau. */
export const sdlcSyncQueue = {
  name: SDLC_SYNC_QUEUE,
  policy: "stately",
  // Lỗi Git được ghi vào dòng đồng bộ và hẹn lại theo lịch riêng; pg-boss chỉ thử lại lỗi của chính hub (DB).
  retryLimit: 2,
  retryDelay: 60,
  expireInSeconds: 10 * 60,
} as const;

export const sdlcPullQueue = {
  name: SDLC_PULL_QUEUE,
  policy: "stately",
  retryLimit: 3,
  retryDelay: 60,
  retryBackoff: true,
  expireInSeconds: 15 * 60,
} as const;

export interface SdlcSyncJob {
  orgId: string;
  itemId: string;
  projectId: string;
}

/** Job quét: theo dự án (webhook `push`, `sha` của nhánh mặc định) hoặc `scan` từ cron cho dự án không có webhook. */
export type SdlcPullJob = { orgId: string; projectId: string; sha?: string | undefined } | { scan: true };

export interface SyncDeps {
  pool: pg.Pool;
  jobs?: Jobs | undefined;
  providerFactory?: ProviderFactory | undefined;
  masterKey?: MasterKey | null | undefined;
  publicUrl?: string | undefined;
  /** `catalog.enqueueMerge`; `sdlc` không gọi thẳng để main.ts quyết định cùng deps của hàng merge (T070). */
  enqueueMerge?:
    | ((
        tx: Tx,
        input: { projectId: string; prNumber: number; prUrl: string; branch: string; runId: null; by: string },
      ) => Promise<unknown>)
    | undefined;
  /** Deps của phiên duyệt cho đề xuất từ repo; vắng thì dùng hook đã tiêm lúc khởi động. */
  review?: ReviewDeps | undefined;
}

// ---- Hàm thuần ----------------------------------------------------------------------------------------------------

export const contentHash = (content: string) => createHash("sha256").update(content).digest("hex");

/** `<NNN>` ở dự án chính, `<home>-<NNN>` ở repo khác để hai hạng mục cùng số của hai dự án không đụng nhau. */
export function syncRef(input: { number: number; homeKey: string; isHome: boolean }): string {
  return input.isHome ? sdlcItemRef(input.number) : `${input.homeKey}-${sdlcItemRef(input.number)}`;
}

export function syncBranch(input: { number: number; slug: string; homeKey: string; isHome: boolean }): string {
  return `hive/sdlc/${syncRef(input)}-${input.slug}`;
}

const COPY_NOTE = "Bản sao do xDev Hive đồng bộ từ";

/** Dòng đầu của bản sao contract; null khi định dạng không có comment (JSON). */
export function copyHeader(format: ContractFormat | null, providerKey: string): string | null {
  const note = `${COPY_NOTE} ${providerKey}; sửa trên hub.`;
  switch (format) {
    case "openapi":
    case "asyncapi":
    case "graphql":
      return `# ${note}`;
    case "proto":
      return `// ${note}`;
    case "markdown":
    case null:
      return `<!-- ${note} -->`;
    case "jsonschema":
      return null;
  }
}

export function withCopyHeader(content: string, format: ContractFormat | null, providerKey: string): string {
  const header = copyHeader(format, providerKey);
  return header ? `${header}\n${content}` : content;
}

/** Nội dung contract từ bản sao trong repo: bỏ dòng đầu hub thêm vào, nếu người sửa còn giữ nó. */
export function stripCopyHeader(content: string): string {
  const nl = content.indexOf("\n");
  const first = nl < 0 ? content : content.slice(0, nl);
  return first.includes(COPY_NOTE) ? content.slice(nl < 0 ? content.length : nl + 1) : content;
}

/** Commit có trailer để người đọc lịch sử repo biết commit nào từ hub và tìm lại hạng mục. */
export function syncCommitMessage(input: {
  ref: string;
  title: string;
  itemId: string;
  docs: { name: string; version: number }[];
  coAuthors: { name: string; email: string }[];
}): string {
  const docs = input.docs.map((d) => `${d.name} v${d.version}`).join(", ");
  const head = `docs(sdlc): ${input.ref} ${input.title} — ${docs}`;
  const subject = head.length > 120 ? `${head.slice(0, 119)}…` : head;
  const seen = new Set<string>();
  const authors = input.coAuthors.filter((a) => {
    const k = a.email.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return [
    subject,
    "",
    `Hive-Sdlc-Item: ${input.itemId}`,
    ...authors.map((a) => `Co-authored-by: ${a.name || a.email} <${a.email}>`),
  ].join("\n");
}

/** Thư mục chung của mọi file, hoặc null khi file nằm rải rác (không có chỗ đặt README mục lục). */
export function commonDir(paths: readonly string[]): string | null {
  const dirs = paths.map((p) => p.split("/").slice(0, -1));
  const first = dirs[0];
  if (!first?.length) return null;
  let n = first.length;
  for (const d of dirs.slice(1)) {
    let i = 0;
    while (i < n && i < d.length && d[i] === first[i]) i += 1;
    n = i;
  }
  return n ? first.slice(0, n).join("/") : null;
}

/**
 * README mục lục ở repo không phải dự án chính: người mở thư mục trong repo này thấy tài liệu chung nằm ở đâu. Không
 * theo dõi như tài liệu (không có trên hub), chỉ ghi lại mỗi lần đồng bộ.
 */
export function readmeIndex(input: {
  ref: string;
  title: string;
  homeKey: string;
  projectKey: string;
  dir: string;
  docs: { name: string; path: string; version: number }[];
  link: string | null;
}): string {
  const lines = [
    `# ${input.ref} ${input.title}`,
    "",
    `Tài liệu của hạng mục AI SDLC ${input.ref} trên xDev Hive. Tài liệu chung (yêu cầu, thiết kế, tách việc) nằm ở repo của dự án chính ${input.homeKey}; thư mục này giữ phần của dự án ${input.projectKey}.`,
    "",
    "Bản gốc nằm trên hub. Sửa file ở đây sẽ thành đề xuất trên hub và đi lại cổng duyệt.",
    "",
    ...input.docs.map((d) => `- [${d.name}](${d.path.slice(input.dir.length + 1)}) — v${d.version}`),
  ];
  if (input.link) lines.push("", `Hạng mục trên hub: ${input.link}`);
  return `${lines.join("\n")}\n`;
}

export type RepoFileState =
  /** Không có file và chưa từng thấy trong nhánh mặc định: PR đồng bộ chưa merge. */
  | "unseen"
  | "deleted"
  /** Giống lần đọc trước: không có gì mới, giữ trạng thái. */
  | "unchanged"
  /** Bằng nội dung hub đã ghi hoặc baseline. */
  | "match"
  | "changed";

/** Xét một file trong nhánh mặc định so với lần đọc trước và với hub (D12). */
export function classifyRepoFile(
  row: { kind: "source" | "copy"; repoHash: string | null; syncedHash: string | null; baselineHash: string | null },
  content: string | null,
): { state: RepoFileState; hash: string | null; content: string | null } {
  if (content === null) return { state: row.repoHash === null ? "unseen" : "deleted", hash: null, content: null };
  const hash = contentHash(content);
  const normalized = row.kind === "copy" ? stripCopyHeader(content) : content;
  if (hash === row.repoHash) return { state: "unchanged", hash, content: normalized };
  if (hash === row.syncedHash || contentHash(normalized) === row.baselineHash)
    return { state: "match", hash, content: normalized };
  return { state: "changed", hash, content: normalized };
}

/** Lần thử thứ `attempt` (đếm từ 1) lỗi thì hẹn lại sau bao lâu; null là đã hết lượt. */
export function retryDelayMs(attempt: number): number | null {
  const minutes = SYNC_RETRY_MINUTES[attempt - 1];
  return minutes === undefined ? null : minutes * 60_000;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

function itemLink(publicUrl: string | undefined, homeKey: string, number: number): string | null {
  return publicUrl ? `${publicUrl.replace(/\/+$/, "")}/sdlc/${homeKey}/${sdlcItemRef(number)}` : null;
}

// ---- Hub → repo ---------------------------------------------------------------------------------------------------

/** Xếp job ghi repo của (hạng mục, dự án), trong transaction của baseline để rollback thì không có job. */
export async function queueSync(
  tx: Tx,
  jobs: Jobs | undefined,
  job: SdlcSyncJob,
  delayMs: number = SYNC_DEBOUNCE_MS,
): Promise<void> {
  if (!jobs) return;
  await jobs.enqueue(SDLC_SYNC_QUEUE, job, {
    tx,
    singletonKey: `${job.itemId}:${job.projectId}`,
    startAfter: new Date(Date.now() + delayMs),
  });
}

type SyncRow = { s: typeof sdlcArtifactSyncs.$inferSelect; a: typeof sdlcArtifacts.$inferSelect };

interface PlannedSync {
  item: typeof sdlcItems.$inferSelect;
  project: ProjectRow;
  home: ProjectRow;
  mode: "pr" | "direct";
  rows: SyncRow[];
  files: { path: string; content: string }[];
  hashes: Map<string, string>;
  message: string;
  provider: GitProvider;
}

class SyncSetupError extends Error {}

function nameOf(item: typeof sdlcItems.$inferSelect, a: typeof sdlcArtifacts.$inferSelect): string {
  const def = item.mode.phases.find((p) => p.id === a.phaseId)?.artifacts.find((x) => x.id === a.artifactId);
  const base = def?.name ?? a.artifactId;
  return a.instance ? `${base} (${a.instance})` : base;
}

/** Đọc mọi thứ cần ghi trong một transaction ngắn, rồi gọi Git ngoài transaction. */
async function planSync(tx: Tx, deps: SyncDeps, job: SdlcSyncJob): Promise<PlannedSync | null> {
  const [item] = await tx.select().from(sdlcItems).where(eq(sdlcItems.id, job.itemId));
  if (!item || item.status === "cancelled") return null;
  const [part] = await tx
    .select()
    .from(sdlcItemProjects)
    .where(
      and(
        eq(sdlcItemProjects.itemId, item.id),
        eq(sdlcItemProjects.projectId, job.projectId),
        isNull(sdlcItemProjects.removedAt),
      ),
    );
  if (!part || part.settings.repoSync === "off") return null;
  const rows = await tx
    .select({ s: sdlcArtifactSyncs, a: sdlcArtifacts })
    .from(sdlcArtifactSyncs)
    .innerJoin(sdlcArtifacts, eq(sdlcArtifacts.id, sdlcArtifactSyncs.artifactId))
    .where(
      and(
        eq(sdlcArtifacts.itemId, item.id),
        eq(sdlcArtifactSyncs.projectId, job.projectId),
        isNotNull(sdlcArtifacts.baselineVersion),
        inArray(sdlcArtifactSyncs.syncState, ["pending", "failed"]),
      ),
    )
    .orderBy(sdlcArtifactSyncs.repoPath);
  if (!rows.length) return null;
  const project = await loadProject(tx, job.projectId);
  const home = project?.id === item.projectId ? project : await loadProject(tx, item.projectId);
  if (!project || !home) throw new SyncSetupError("Không tìm thấy dự án.");
  if (!deps.providerFactory || !deps.masterKey) throw new SyncSetupError("Hub chưa cấu hình kết nối Git.");
  const conn = await loadConnection(tx, deps.masterKey, project.scmConnectionId);
  if (!conn) throw new SyncSetupError(`Dự án ${project.key} không còn kết nối Git.`);

  const owner: Principal = { kind: "user", userId: item.ownerUserId };
  const files: PlannedSync["files"] = [];
  const hashes = new Map<string, string>();
  const docs: { name: string; path: string; version: number }[] = [];
  const authorIds = new Set([item.ownerUserId]);
  const providerKeys = new Map<string, string>([[project.id, project.key]]);
  for (const { s, a } of rows) {
    const version = a.baselineVersion ?? 0;
    let doc: Awaited<ReturnType<typeof getDoc>>;
    try {
      doc = await getDoc(tx, owner, { key: a.docKey, version });
    } catch (e) {
      throw new SyncSetupError(`Không đọc được ${a.docKey} v${version}: ${errorText(e)}`);
    }
    if (doc.updatedBy.userId) authorIds.add(doc.updatedBy.userId);
    let content = doc.content;
    if (s.kind === "copy") {
      if (!providerKeys.has(a.projectId))
        providerKeys.set(a.projectId, (await loadProject(tx, a.projectId))?.key ?? "");
      content = withCopyHeader(content, a.contractFormat as ContractFormat | null, providerKeys.get(a.projectId) ?? "");
    }
    files.push({ path: s.repoPath, content });
    hashes.set(s.repoPath, contentHash(content));
    docs.push({ name: nameOf(item, a), path: s.repoPath, version });
  }

  const isHome = project.id === home.id;
  const ref = syncRef({ number: item.number, homeKey: home.key, isHome });
  if (!isHome) {
    const dir = commonDir(files.map((f) => f.path));
    const readme = dir ? `${dir}/README.md` : null;
    if (readme && !files.some((f) => f.path === readme))
      files.push({
        path: readme,
        content: readmeIndex({
          ref,
          title: item.title,
          homeKey: home.key,
          projectKey: project.key,
          dir: dir ?? "",
          docs,
          link: itemLink(deps.publicUrl, home.key, item.number),
        }),
      });
  }
  const people = await tx
    .select({ name: authUser.name, email: authUser.email })
    .from(authUser)
    .where(inArray(authUser.id, [...authorIds]));
  return {
    item,
    project,
    home,
    mode: part.settings.repoSync,
    rows,
    files,
    hashes,
    message: syncCommitMessage({ ref, title: item.title, itemId: item.id, docs, coAuthors: people }),
    provider: deps.providerFactory(conn),
  };
}

/** Ghi lên repo; trả commit, và PR khi cách `pr`. */
async function pushFiles(
  deps: SyncDeps,
  plan: PlannedSync,
): Promise<{ sha: string; pr: { number: number; url: string; branch: string } | null }> {
  const { provider, project, home, item } = plan;
  const repo = { owner: project.repoOwner, name: project.repoName };
  const base = project.defaultBranch ?? "main";
  if (plan.mode === "direct") {
    const { sha } = await provider.commitFiles(repo, { branch: base, message: plan.message, files: plan.files });
    return { sha, pr: null };
  }
  const isHome = project.id === home.id;
  const branch = syncBranch({ number: item.number, slug: item.slug, homeKey: home.key, isHome });
  const { sha } = await provider.commitFiles(repo, {
    branch,
    fromBranch: base,
    message: plan.message,
    files: plan.files,
  });
  const link = itemLink(deps.publicUrl, home.key, item.number);
  const ref = syncRef({ number: item.number, homeKey: home.key, isHome });
  const pr = await provider.openPR(repo, {
    head: branch,
    base,
    title: `docs(sdlc): ${ref} ${item.title}`.slice(0, 200),
    body: [
      `Tài liệu của hạng mục AI SDLC ${ref} “${item.title}” đã qua cổng duyệt trên xDev Hive.`,
      "PR này chỉ chép baseline vào repo nên không cần review code; sửa tài liệu trên hub.",
      ...(link ? ["", link] : []),
    ].join("\n"),
  });
  // Nội dung đã qua cổng trên hub (D11): commit status thay cho người duyệt mà bảo vệ nhánh đòi.
  await provider.setCommitStatus(repo, sha, {
    context: SYNC_STATUS_CONTEXT,
    state: "success",
    description: "Tài liệu đã qua cổng duyệt trên xDev Hive",
    ...(link ? { targetUrl: link } : {}),
  });
  return { sha, pr: { ...pr, branch } };
}

async function recordSuccess(
  tx: Tx,
  deps: SyncDeps,
  plan: PlannedSync,
  out: Awaited<ReturnType<typeof pushFiles>>,
): Promise<void> {
  // Baseline mới tới giữa lúc ghi thì dòng đã về `pending` với phiên bản khác: để job kế ghi tiếp.
  for (const { s, a } of plan.rows)
    await tx
      .update(sdlcArtifactSyncs)
      .set({
        syncState: "synced",
        syncedVersion: a.baselineVersion,
        syncedCommit: out.sha,
        syncedHash: plan.hashes.get(s.repoPath) ?? null,
        syncError: null,
        syncAttempts: 0,
        syncedAt: sql`now()`,
        ...(out.pr ? { prNumber: out.pr.number, prUrl: out.pr.url } : {}),
      })
      .where(
        and(
          eq(sdlcArtifactSyncs.artifactId, s.artifactId),
          eq(sdlcArtifactSyncs.projectId, s.projectId),
          sql`exists (select 1 from ${sdlcArtifacts} where ${and(
            eq(sdlcArtifacts.id, s.artifactId),
            eq(sdlcArtifacts.baselineVersion, a.baselineVersion ?? -1),
          )})`,
        ),
      );
  // Dự án tắt hàng merge thì PR chờ người merge; màn hạng mục có link PR (plan.md "Đồng bộ hub ↔ repo").
  if (out.pr && plan.project.settings.features.mergeQueue && deps.enqueueMerge)
    await deps.enqueueMerge(tx, {
      projectId: plan.project.id,
      prNumber: out.pr.number,
      prUrl: out.pr.url,
      branch: out.pr.branch,
      runId: null,
      by: SYSTEM_ACTOR,
    });
  await recordAudit(tx, {
    action: "sdlc.sync.commit",
    actorUserId: null,
    targetType: "sdlc_item",
    targetId: plan.item.id,
    data: {
      projectId: plan.project.id,
      mode: plan.mode,
      commit: out.sha,
      prUrl: out.pr?.url ?? null,
      files: plan.rows.map(({ s, a }) => ({ path: s.repoPath, kind: s.kind, version: a.baselineVersion })),
    },
  });
}

async function recordFailure(tx: Tx, deps: SyncDeps, job: SdlcSyncJob, error: string): Promise<void> {
  const rows = await tx
    .select({ s: sdlcArtifactSyncs })
    .from(sdlcArtifactSyncs)
    .innerJoin(sdlcArtifacts, eq(sdlcArtifacts.id, sdlcArtifactSyncs.artifactId))
    .where(
      and(
        eq(sdlcArtifacts.itemId, job.itemId),
        eq(sdlcArtifactSyncs.projectId, job.projectId),
        isNotNull(sdlcArtifacts.baselineVersion),
        inArray(sdlcArtifactSyncs.syncState, ["pending", "failed"]),
      ),
    );
  if (!rows.length) return;
  const attempt = Math.max(...rows.map((r) => r.s.syncAttempts)) + 1;
  for (const { s } of rows)
    await tx
      .update(sdlcArtifactSyncs)
      .set({ syncState: "failed", syncError: error, syncAttempts: attempt })
      .where(and(eq(sdlcArtifactSyncs.artifactId, s.artifactId), eq(sdlcArtifactSyncs.projectId, s.projectId)));
  const delay = retryDelayMs(attempt);
  if (delay !== null) await queueSync(tx, deps.jobs, job, delay);
  await recordAudit(tx, {
    action: "sdlc.sync.fail",
    actorUserId: null,
    targetType: "sdlc_item",
    targetId: job.itemId,
    data: { projectId: job.projectId, attempt, error, retryInMs: delay },
  });
  // Báo một lần ở lỗi đầu (US4-2): quản trị dự án sửa quyền sớm thì các lần thử lại sau sẽ qua.
  if (attempt === 1) await notifySyncFailed(tx, deps, job, error);
}

async function notifySyncFailed(tx: Tx, deps: SyncDeps, job: SdlcSyncJob, error: string): Promise<void> {
  const [item] = await tx.select().from(sdlcItems).where(eq(sdlcItems.id, job.itemId));
  const project = await loadProject(tx, job.projectId);
  if (!item || !project) return;
  const home = project.id === item.projectId ? project : await loadProject(tx, item.projectId);
  const admins = await teamMemberIds(tx, project.teamId, "admin");
  const recipientIds = await itemViewers(tx, item, admins.length ? admins : [item.ownerUserId]);
  if (!recipientIds.length) return;
  const ref = syncRef({ number: item.number, homeKey: home?.key ?? "", isHome: project.id === item.projectId });
  await notify(
    tx,
    {
      orgId: item.orgId,
      event: "sdlc.sync_failed",
      title: `Chưa đồng bộ được tài liệu ${ref} vào repo ${project.key}`,
      body: `${item.title}: ${error} Hub sẽ thử lại; sửa quyền hoặc bảo vệ nhánh rồi bấm “Đồng bộ lại” nếu cần.`,
      eventKey: `sdlc.sync_failed:${item.id}:${project.id}:${Date.now()}`,
      recipientIds,
      link: itemLink(deps.publicUrl, home?.key ?? project.key, item.number),
    },
    { jobs: deps.jobs },
  );
}

/** Job `sdlc-sync`: gom file của một repo thành một commit (D11). Lỗi Git ghi vào dòng đồng bộ, không ném ra pg-boss. */
export async function syncItemProject(deps: SyncDeps, job: SdlcSyncJob): Promise<"synced" | "failed" | "skipped"> {
  const ctx = { orgId: job.orgId };
  let plan: PlannedSync | null;
  try {
    plan = await withTenant(deps.pool, ctx, (tx) => planSync(tx, deps, job));
  } catch (e) {
    if (!(e instanceof SyncSetupError)) throw e;
    await withTenant(deps.pool, ctx, (tx) => recordFailure(tx, deps, job, e.message));
    return "failed";
  }
  if (!plan) return "skipped";
  let out: Awaited<ReturnType<typeof pushFiles>>;
  try {
    out = await pushFiles(deps, plan);
  } catch (e) {
    await withTenant(deps.pool, ctx, (tx) => recordFailure(tx, deps, job, errorText(e)));
    return "failed";
  }
  const done = plan;
  await withTenant(deps.pool, ctx, (tx) => recordSuccess(tx, deps, done, out));
  return "synced";
}

// ---- Repo → hub ---------------------------------------------------------------------------------------------------

/** Webhook `push` vào nhánh mặc định của dự án có hạng mục: xếp job đọc, gộp các push trong 30 s (D12). */
export async function onSdlcPush(event: PushEvent, ctx: ScmEventContext, jobs: Jobs | undefined): Promise<void> {
  if (!jobs) return;
  const project = await loadProject(ctx.tx, ctx.projectId);
  if (!project || event.branch !== (project.defaultBranch ?? "main")) return;
  const [tracked] = await ctx.tx
    .select({ itemId: sdlcItemProjects.itemId })
    .from(sdlcItemProjects)
    .where(and(eq(sdlcItemProjects.projectId, project.id), isNull(sdlcItemProjects.removedAt)))
    .limit(1);
  if (!tracked) return;
  // Không mang `sha` theo: job gộp nhiều push nên đọc đầu nhánh lúc chạy, mới hơn sha của push đầu.
  await jobs.enqueue(SDLC_PULL_QUEUE, { orgId: ctx.orgId, projectId: project.id } satisfies SdlcPullJob, {
    tx: ctx.tx,
    singletonKey: project.id,
    startAfter: new Date(Date.now() + PULL_DEBOUNCE_MS),
  });
}

type PullRow = SyncRow & { item: typeof sdlcItems.$inferSelect };

/** Hash của các phiên bản hub cũ hơn baseline: lần đọc đầu có thể gặp bản cũ hub đã ghi trước khi PR mới merge. */
async function hubVersionHashes(tx: Tx, principal: Principal, key: string, below: number): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const versions = (await docHistory(tx, principal, { key })).filter((v) => v.version < below).slice(0, 10);
    for (const v of versions) out.add(contentHash((await getDoc(tx, principal, { key, version: v.version })).content));
  } catch {
    // Chủ mất quyền đọc thì coi như không khớp bản nào; đề xuất cũng sẽ không tạo được và dòng ghi lỗi.
  }
  return out;
}

async function proposeFromRepo(
  tx: Tx,
  deps: SyncDeps,
  row: PullRow,
  project: ProjectRow,
  sha: string,
  content: string,
): Promise<{ proposalId: string | null; error: string | null }> {
  const owner: Principal = { kind: "user", userId: row.item.ownerUserId };
  const where = row.s.kind === "copy" ? " (bản sao contract)" : "";
  // Savepoint: đề xuất lỗi (chủ mất quyền, nội dung quá dài) không làm hỏng các file khác của cùng lần đọc.
  await tx.execute(sql`savepoint sdlc_repo_proposal`);
  try {
    const current = await getDoc(tx, owner, { key: row.a.docKey });
    const proposal = await createProposal(tx, owner, {
      kind: "doc",
      key: row.a.docKey,
      title: current.title,
      content,
      baseVersion: current.version,
      reason: `Sửa trong repo ${project.key}${where}: ${sha.slice(0, 7)}`.slice(0, 500),
    });
    await startReview(tx, proposal.id, deps.review ?? {});
    await tx.execute(sql`release savepoint sdlc_repo_proposal`);
    return { proposalId: proposal.id, error: null };
  } catch (e) {
    await tx.execute(sql`rollback to savepoint sdlc_repo_proposal`);
    await tx.execute(sql`release savepoint sdlc_repo_proposal`);
    return { proposalId: null, error: `Không tạo được đề xuất từ repo: ${errorText(e)}` };
  }
}

/** Job `sdlc-pull` của một dự án: so file trong nhánh mặc định với hub, tạo đề xuất khi repo sửa (D12). */
export async function pullProject(
  deps: SyncDeps,
  job: { orgId: string; projectId: string; sha?: string | undefined },
): Promise<{ checked: number; proposals: number }> {
  const ctx = { orgId: job.orgId };
  const pre = await withTenant(deps.pool, ctx, async (tx) => {
    const project = await loadProject(tx, job.projectId);
    if (!project || !deps.providerFactory || !deps.masterKey) return null;
    const rows = (
      await tx
        .select({ s: sdlcArtifactSyncs, a: sdlcArtifacts, item: sdlcItems, settings: sdlcItemProjects.settings })
        .from(sdlcArtifactSyncs)
        .innerJoin(sdlcArtifacts, eq(sdlcArtifacts.id, sdlcArtifactSyncs.artifactId))
        .innerJoin(sdlcItems, eq(sdlcItems.id, sdlcArtifacts.itemId))
        .innerJoin(
          sdlcItemProjects,
          and(
            eq(sdlcItemProjects.itemId, sdlcItems.id),
            eq(sdlcItemProjects.projectId, sdlcArtifactSyncs.projectId),
            isNull(sdlcItemProjects.removedAt),
          ),
        )
        .where(
          and(
            eq(sdlcArtifactSyncs.projectId, project.id),
            inArray(sdlcItems.status, ["active", "paused"]),
            isNotNull(sdlcArtifacts.baselineVersion),
          ),
        )
        // Dòng lâu chưa đồng bộ trước, để dự án quá 200 file vẫn lần lượt được xét.
        .orderBy(sql`${sdlcArtifactSyncs.syncedAt} asc nulls first`, sdlcArtifactSyncs.repoPath)
        .limit(PULL_MAX_FILES)
    ).filter((r) => r.settings.repoSync !== "off");
    if (!rows.length) return null;
    const conn = await loadConnection(tx, deps.masterKey, project.scmConnectionId);
    return conn ? { project, rows, provider: deps.providerFactory(conn) } : null;
  });
  if (!pre) return { checked: 0, proposals: 0 };
  const { project, rows, provider } = pre;
  const repo = { owner: project.repoOwner, name: project.repoName };
  const sha = job.sha ?? (await provider.branchHead(repo, project.defaultBranch ?? "main"));
  if (!sha) return { checked: 0, proposals: 0 };
  const contents = new Map<string, string | null>();
  for (const path of new Set(rows.map((r) => r.s.repoPath)))
    contents.set(path, await provider.readFile(repo, path, sha));

  return withTenant(deps.pool, ctx, async (tx) => {
    let proposals = 0;
    for (const row of rows) {
      const { s, a } = row;
      const seen = classifyRepoFile(
        { kind: s.kind, repoHash: s.repoHash, syncedHash: s.syncedHash, baselineHash: a.baselineHash },
        contents.get(s.repoPath) ?? null,
      );
      let state = seen.state;
      const owner: Principal = { kind: "user", userId: row.item.ownerUserId };
      if (state === "changed" && s.repoHash === null && seen.content !== null) {
        const old = await hubVersionHashes(tx, owner, a.docKey, a.baselineVersion ?? 0);
        if (old.has(contentHash(seen.content))) state = "match";
      }
      const where = and(eq(sdlcArtifactSyncs.artifactId, s.artifactId), eq(sdlcArtifactSyncs.projectId, s.projectId));
      if (state === "unseen" || state === "unchanged") continue;
      if (state === "match") {
        await tx
          .update(sdlcArtifactSyncs)
          .set({
            repoHash: seen.hash,
            ...(s.syncState === "drifted" || s.syncState === "deleted" ? { syncState: "synced", syncError: null } : {}),
          })
          .where(where);
        continue;
      }
      if (state === "deleted") {
        await tx.update(sdlcArtifactSyncs).set({ repoHash: null, syncState: "deleted" }).where(where);
        await recordAudit(tx, {
          action: "sdlc.sync.drift",
          actorUserId: null,
          targetType: "sdlc_item",
          targetId: row.item.id,
          data: { projectId: project.id, path: s.repoPath, kind: s.kind, deleted: true, sha },
        });
        continue;
      }
      const made = await proposeFromRepo(tx, deps, row, project, sha, seen.content ?? "");
      if (made.proposalId) proposals += 1;
      await tx
        .update(sdlcArtifactSyncs)
        .set({ repoHash: seen.hash, syncState: "drifted", syncError: made.error })
        .where(where);
      await recordAudit(tx, {
        action: "sdlc.sync.drift",
        actorUserId: null,
        targetType: "sdlc_item",
        targetId: row.item.id,
        data: { projectId: project.id, path: s.repoPath, kind: s.kind, sha, proposalId: made.proposalId },
      });
    }
    return { checked: rows.length, proposals };
  });
}

/**
 * Cron 15 phút: dự án không có webhook (repo hub không cài được hook) không bao giờ nhận `push`, nên quét định kỳ.
 * `hive.sdlc_active_orgs()` chỉ trả tổ chức có hạng mục đang chạy; phần còn lại chạy trong tổ chức đó.
 */
export async function scanProjects(deps: SyncDeps): Promise<number> {
  const orgs = await withTenant(deps.pool, {}, async (tx) => {
    const { rows } = await tx.execute<{ org_id: string }>(sql`select org_id from hive.sdlc_active_orgs()`);
    return rows.map((r) => r.org_id);
  });
  let queued = 0;
  for (const orgId of orgs) {
    const projectIds = await withTenant(deps.pool, { orgId }, async (tx) => {
      const rows = await tx
        .selectDistinct({ projectId: sdlcItemProjects.projectId })
        .from(sdlcItemProjects)
        .innerJoin(sdlcItems, eq(sdlcItems.id, sdlcItemProjects.itemId))
        .where(and(isNull(sdlcItemProjects.removedAt), inArray(sdlcItems.status, ["active", "paused"])));
      const out: string[] = [];
      for (const { projectId } of rows) {
        const project = await loadProject(tx, projectId);
        if (project && project.webhookSecretEnc === null) out.push(projectId);
      }
      return out;
    });
    for (const projectId of projectIds) {
      if (deps.jobs)
        await deps.jobs.enqueue(SDLC_PULL_QUEUE, { orgId, projectId } satisfies SdlcPullJob, {
          singletonKey: projectId,
        });
      else await pullProject(deps, { orgId, projectId });
      queued += 1;
    }
  }
  return queued;
}

export async function handleSdlcPullJob(deps: SyncDeps, job: SdlcPullJob): Promise<void> {
  if ("scan" in job) await scanProjects(deps);
  else await pullProject(deps, job);
}

/** main.ts thêm `sdlcSyncQueue`, `sdlcPullQueue` vào danh sách queue rồi gọi hàm này ở tiến trình `jobs` (T070). */
export async function registerSdlcSync(jobs: Jobs, deps: SyncDeps): Promise<void> {
  const full = { ...deps, jobs };
  await jobs.work<SdlcSyncJob>(SDLC_SYNC_QUEUE, async ({ data }) => void (await syncItemProject(full, data)));
  await jobs.work<SdlcPullJob>(SDLC_PULL_QUEUE, ({ data }) => handleSdlcPullJob(full, data));
  await jobs.schedule(SDLC_PULL_QUEUE, SDLC_PULL_CRON, { scan: true } satisfies SdlcPullJob);
  onScmEvent("push", (event, ctx) => onSdlcPush(event, ctx, jobs));
}

// ---- Route `sync` -------------------------------------------------------------------------------------------------

/**
 * "Đồng bộ lại" (dòng lỗi) và "Ghi đè repo bằng baseline" (mọi dòng có baseline, kể cả lệch repo) của một repo
 * (FR-023). Chỉ quản trị đội giữ repo (`sdlc.override`): ghi đè làm mất sửa đổi trong repo.
 */
export async function requestSync(
  tx: Tx,
  userId: string,
  input: { id: string; projectId: string; action: "retry" | "overwrite-repo" },
  deps: { jobs?: Jobs | undefined } = {},
): Promise<SdlcArtifactSync[]> {
  const item = await itemForUser(tx, userId, input.id, true);
  await requireProjectWrite(tx, userId, [input.projectId], "sdlc.override");
  const [part] = await tx
    .select()
    .from(sdlcItemProjects)
    .where(
      and(
        eq(sdlcItemProjects.itemId, item.id),
        eq(sdlcItemProjects.projectId, input.projectId),
        isNull(sdlcItemProjects.removedAt),
      ),
    );
  if (!part) throw new BadRequestError("SDLC_PROJECT_NOT_IN_ITEM", "Dự án không tham gia hạng mục này.");
  if (part.settings.repoSync === "off")
    throw new BadRequestError("SDLC_SYNC_OFF", "Dự án tắt đồng bộ repo; tài liệu chỉ nằm trên hub.");
  const states =
    input.action === "retry"
      ? (["failed", "pending"] as const)
      : (["none", "pending", "synced", "failed", "drifted", "deleted"] as const);
  const ids = (
    await tx
      .select({ id: sdlcArtifacts.id })
      .from(sdlcArtifacts)
      .where(and(eq(sdlcArtifacts.itemId, item.id), isNotNull(sdlcArtifacts.baselineVersion)))
  ).map((r) => r.id);
  const touched = ids.length
    ? await tx
        .update(sdlcArtifactSyncs)
        .set({ syncState: "pending", syncError: null, syncAttempts: 0 })
        .where(
          and(
            inArray(sdlcArtifactSyncs.artifactId, ids),
            eq(sdlcArtifactSyncs.projectId, input.projectId),
            inArray(sdlcArtifactSyncs.syncState, [...states]),
          ),
        )
        .returning({ path: sdlcArtifactSyncs.repoPath })
    : [];
  await recordAudit(tx, {
    action: input.action === "retry" ? "sdlc.sync.retry" : "sdlc.sync.overwrite",
    targetType: "sdlc_item",
    targetId: item.id,
    data: { projectId: input.projectId, paths: touched.map((t) => t.path) },
  });
  if (touched.length)
    await queueSync(tx, deps.jobs, { orgId: item.orgId, itemId: item.id, projectId: input.projectId }, 0);
  const artifacts = await tx
    .select()
    .from(sdlcArtifacts)
    .where(eq(sdlcArtifacts.itemId, item.id))
    .orderBy(sdlcArtifacts.repoPath);
  return (await artifactViews(tx, item, artifacts)).flatMap((a) =>
    a.syncs.filter((s) => s.projectId === input.projectId),
  );
}

/** Hàm đăng ký riêng để router.ts chỉ thêm một dòng `sync: syncRoute(deps)` (T070 gộp). */
export function syncRoute(deps: OrgDeps & { jobs?: Jobs | undefined }) {
  const { authed, inOrg } = orgMiddlewares(deps);
  const os = implement(contract.sdlc).$context<RequestContext>().use(authed).use(inOrg);
  return os.sync.handler(({ context: { tx, user }, input }) => requestSync(tx, user.id, input, deps));
}
