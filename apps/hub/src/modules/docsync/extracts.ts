import {
  DOC_MAX_CHARS,
  type DocExtract,
  docExtract,
  docExtractState,
  docExtractSummary,
  docExtractUpdateInput,
  type SecretFinding,
  scanSecrets,
} from "@xdev-hive/contracts";
import { and, asc, eq, gt, inArray, lt, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/index.ts";
import { loadProject } from "../catalog/index.ts";
import { assertCanManageScope, indexExtract, listDocs, type Principal } from "../knowledge/index.ts";
import { notify } from "../notify/index.ts";
import {
  BadRequestError,
  ConflictError,
  createPostgresBlobStore,
  ForbiddenError,
  type Jobs,
  NotFoundError,
  type Tx,
  withTenant,
} from "../platform/index.ts";
import { notificationRecipients, teamMemberIds } from "../tenancy/index.ts";
import { extractKind } from "./extract/extract.ts";
import { type RunExtractOptions, runExtract } from "./extract/run.ts";
import { requireHomeManage } from "./homes.ts";
import { DOCSYNC_EXTRACT_QUEUE } from "./queues.ts";
import type { DocSyncDeps } from "./routes/deps.ts";
import { docAssets, docExtracts, docHomes } from "./schema.ts";

type ExtractRow = typeof docExtracts.$inferSelect;
type AssetRow = typeof docAssets.$inferSelect;
type HomeRow = typeof docHomes.$inferSelect;
type DocExtractSummary = z.output<typeof docExtractSummary>;
type ExtractDeps = DocSyncDeps & { pool: NonNullable<DocSyncDeps["pool"]>; run?: RunExtractOptions };

export type DocExtractJob = { orgId: string; assetId: string; extractId: string } | { scan: true };

export const DOCSYNC_EXTRACT_CRON = "*/10 * * * *";
/** Mỗi lượt quét chỉ tạo chừng này bản trích cho một tổ chức; phần còn lại để lượt sau, tránh dồn job sau khi nhập lớn. */
const SWEEP_BATCH = 200;
/** Bản `pending` không được job nào nhận (hub tắt giữa chừng, job hết hạn) thì xếp lại sau khoảng này. */
const STALE_PENDING_MS = 15 * 60_000;
const EXTRACTABLE_SQL = String.raw`\.(docx|xlsx|pptx|pdf|csv)$`;

const notFound = () => new NotFoundError("DOCSYNC_EXTRACT_NOT_FOUND", "Không tìm thấy bản trích.");
const listInput = z.object({
  homeId: z.uuid().optional(),
  state: docExtractState.optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
const actionInput = z.object({ id: z.uuid(), updatedAt: z.iso.datetime() });

export class ExtractSecretError extends BadRequestError {
  readonly findings: SecretFinding[];

  constructor(findings: SecretFinding[]) {
    super(
      "DOC_SECRET_FOUND",
      "Bản trích có dấu hiệu bí mật. Sửa nội dung hoặc xác nhận không phải bí mật trước khi duyệt.",
    );
    this.findings = findings;
  }
}

// ---- Quyền duyệt --------------------------------------------------------------------------------------------------

/**
 * Duyệt cần `manage` trên phạm vi nhà, hoặc trên tài liệu chủ của file (plan.md mục 9). Tính một lần cho cả danh sách:
 * số nhà và số phạm vi tài liệu trong tổ chức nhỏ, còn số bản trích có thể lớn.
 */
async function reviewScope(tx: Tx, userId: string): Promise<{ homeIds: Set<string>; docIds: Set<string> }> {
  const homeIds = new Set<string>();
  for (const home of await tx.select().from(docHomes)) if (await canManageHome(tx, userId, home)) homeIds.add(home.id);
  const docIds = new Set<string>();
  const scopes = new Map<string, boolean>();
  for (const doc of await listDocs(tx, { kind: "user", userId }, {})) {
    const scope = doc.scope.teamId ?? "org";
    let allowed = scopes.get(scope);
    if (allowed === undefined) {
      allowed = await allowedBy(() => assertCanManageScope(tx, userId, doc.scope));
      scopes.set(scope, allowed);
    }
    if (allowed) docIds.add(doc.id);
  }
  return { homeIds, docIds };
}

async function allowedBy(check: () => Promise<unknown>): Promise<boolean> {
  try {
    await check();
    return true;
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof NotFoundError) return false;
    throw error;
  }
}

const canManageHome = (tx: Tx, userId: string, home: HomeRow) => allowedBy(() => requireHomeManage(tx, userId, home));

async function canReview(tx: Tx, userId: string, asset: AssetRow): Promise<boolean> {
  const [home] = await tx.select().from(docHomes).where(eq(docHomes.id, asset.homeId));
  if (home && (await canManageHome(tx, userId, home))) return true;
  if (!asset.ownerDocId) return false;
  const doc = (await listDocs(tx, { kind: "user", userId }, {})).find((d) => d.id === asset.ownerDocId);
  return doc ? allowedBy(() => assertCanManageScope(tx, userId, doc.scope)) : false;
}

function reviewer(principal: Principal): string {
  if (principal.kind !== "user") throw new ForbiddenError("RUN_NOT_ALLOWED", "Agent không được duyệt bản trích.");
  return principal.userId;
}

// ---- Đọc ------------------------------------------------------------------------------------------------------------

function summary(row: ExtractRow, asset: AssetRow): DocExtractSummary {
  return docExtractSummary.parse({
    ...row,
    homeId: asset.homeId,
    repoPath: asset.repoPath,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

// Không có cột lưu findings: quét lại khi đọc, chỉ khi còn cờ, để kết quả luôn khớp nội dung đang sửa.
function detail(row: ExtractRow, asset: AssetRow): DocExtract {
  return docExtract.parse({
    ...summary(row, asset),
    content: row.content,
    findings: row.secretFlag ? scanSecrets(row.content) : [],
  });
}

export async function listExtracts(
  tx: Tx,
  principal: Principal,
  input: z.input<typeof listInput>,
): Promise<{ items: DocExtractSummary[]; nextCursor: string | null }> {
  const data = listInput.parse(input);
  if (data.cursor !== undefined && !z.uuid().safeParse(data.cursor).success)
    throw new BadRequestError("DOCSYNC_INVALID_CURSOR", "Con trỏ danh sách bản trích không hợp lệ.");
  if (principal.kind !== "user") return { items: [], nextCursor: null };
  const { homeIds, docIds } = await reviewScope(tx, principal.userId);
  if (!homeIds.size && !docIds.size) return { items: [], nextCursor: null };
  const rows = await tx
    .select({ extract: docExtracts, asset: docAssets })
    .from(docExtracts)
    .innerJoin(docAssets, eq(docAssets.id, docExtracts.assetId))
    .where(
      and(
        or(
          homeIds.size ? inArray(docAssets.homeId, [...homeIds]) : undefined,
          docIds.size ? inArray(docAssets.ownerDocId, [...docIds]) : undefined,
        ),
        data.homeId ? eq(docAssets.homeId, data.homeId) : undefined,
        data.state ? eq(docExtracts.state, data.state) : undefined,
        data.cursor ? gt(docExtracts.id, data.cursor) : undefined,
      ),
    )
    .orderBy(asc(docExtracts.id))
    .limit(data.limit + 1);
  const items = rows.slice(0, data.limit).map(({ extract, asset }) => summary(extract, asset));
  return { items, nextCursor: rows.length > data.limit ? (items.at(-1)?.id ?? null) : null };
}

async function loadReviewable(
  tx: Tx,
  principal: Principal,
  id: string,
  lock: boolean,
): Promise<{ row: ExtractRow; asset: AssetRow }> {
  if (!z.uuid().safeParse(id).success) throw notFound();
  const query = tx.select().from(docExtracts).where(eq(docExtracts.id, id));
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw notFound();
  const [asset] = await tx.select().from(docAssets).where(eq(docAssets.id, row.assetId));
  // Không có quyền duyệt thì trả như không tồn tại: bản trích có thể chứa nội dung của tài liệu người gọi không đọc được.
  if (!asset || !(await canReview(tx, reviewer(principal), asset))) throw notFound();
  return { row, asset };
}

export async function getExtract(tx: Tx, principal: Principal, id: string): Promise<DocExtract> {
  const { row, asset } = await loadReviewable(tx, principal, id, false);
  return detail(row, asset);
}

// ---- Sửa, duyệt, từ chối --------------------------------------------------------------------------------------------

function assertFresh(row: ExtractRow, updatedAt: string) {
  if (row.updatedAt.toISOString() !== new Date(updatedAt).toISOString())
    throw new ConflictError("DOCSYNC_EXTRACT_CHANGED", "Bản trích vừa được người khác sửa. Tải lại rồi thử lại.");
}

function assertReview(row: ExtractRow, asset: AssetRow) {
  if (row.state !== "review")
    throw new ConflictError("DOCSYNC_EXTRACT_STATE", "Bản trích không còn ở trạng thái chờ duyệt.");
  // Bản trích của file cũ: lượt quét sẽ tạo bản mới, duyệt bản cũ chỉ đưa nội dung lỗi thời vào tìm kiếm.
  if (row.sourceSha256 !== asset.sha256)
    throw new ConflictError("DOCSYNC_EXTRACT_STALE", "File gốc đã đổi. Chờ bản trích mới để duyệt.");
}

export async function updateExtract(
  tx: Tx,
  principal: Principal,
  input: z.input<typeof docExtractUpdateInput>,
): Promise<DocExtract> {
  const data = docExtractUpdateInput.parse(input);
  const { row, asset } = await loadReviewable(tx, principal, data.id, true);
  assertFresh(row, data.updatedAt);
  assertReview(row, asset);
  const [saved] = await tx
    .update(docExtracts)
    .set({ content: data.content, secretFlag: scanSecrets(data.content).length > 0, updatedAt: new Date() })
    .where(eq(docExtracts.id, row.id))
    .returning();
  if (!saved) throw notFound();
  return detail(saved, asset);
}

export async function approveExtract(
  tx: Tx,
  principal: Principal,
  input: z.input<typeof actionInput>,
): Promise<DocExtract> {
  const data = actionInput.parse(input);
  const userId = reviewer(principal);
  const { row, asset } = await loadReviewable(tx, principal, data.id, true);
  assertFresh(row, data.updatedAt);
  assertReview(row, asset);
  if (row.secretFlag) throw new ExtractSecretError(scanSecrets(row.content));
  const now = new Date();
  // Bản đã duyệt cũ được giữ tới đúng lúc này (FR-035); chỉ mục unique cho phép một bản `approved` mỗi file.
  const replaced = await tx
    .update(docExtracts)
    .set({ state: "rejected", error: "Đã thay bằng bản trích mới hơn.", updatedAt: now })
    .where(and(eq(docExtracts.assetId, asset.id), eq(docExtracts.state, "approved")))
    .returning({ id: docExtracts.id });
  const [saved] = await tx
    .update(docExtracts)
    .set({ state: "approved", error: null, reviewedBy: userId, reviewedAt: now, updatedAt: now })
    .where(eq(docExtracts.id, row.id))
    .returning();
  if (!saved) throw notFound();
  await recordAudit(tx, {
    action: "doc.extract_approve",
    actorUserId: userId,
    targetType: "doc_extract",
    targetId: row.id,
    data: {
      assetId: asset.id,
      homeId: asset.homeId,
      repoPath: asset.repoPath,
      sourceSha256: row.sourceSha256,
      replaced: replaced.map((r) => r.id),
    },
  });
  // Chỉ mục xoá đoạn của bản cũ cùng file khi ghi đoạn của bản này.
  await indexExtract(tx, row.id);
  return detail(saved, asset);
}

export async function rejectExtract(
  tx: Tx,
  principal: Principal,
  input: z.input<typeof actionInput>,
): Promise<DocExtract> {
  const data = actionInput.parse(input);
  const userId = reviewer(principal);
  const { row, asset } = await loadReviewable(tx, principal, data.id, true);
  assertFresh(row, data.updatedAt);
  if (row.state !== "review" && row.state !== "approved")
    throw new ConflictError("DOCSYNC_EXTRACT_STATE", "Chỉ từ chối được bản trích đang chờ duyệt hoặc đã duyệt.");
  const now = new Date();
  const [saved] = await tx
    .update(docExtracts)
    .set({ state: "rejected", reviewedBy: userId, reviewedAt: now, updatedAt: now })
    .where(eq(docExtracts.id, row.id))
    .returning();
  if (!saved) throw notFound();
  await recordAudit(tx, {
    action: "doc.extract_reject",
    actorUserId: userId,
    targetType: "doc_extract",
    targetId: row.id,
    data: { assetId: asset.id, homeId: asset.homeId, repoPath: asset.repoPath, previousState: row.state },
  });
  // Bỏ bản đã duyệt thì phải gỡ khỏi tìm kiếm ngay, không chờ bản sau.
  if (row.state === "approved") await indexExtract(tx, row.id);
  return detail(saved, asset);
}

export async function confirmExtractSecret(
  tx: Tx,
  principal: Principal,
  input: z.input<typeof actionInput>,
): Promise<DocExtract> {
  const data = actionInput.parse(input);
  const userId = reviewer(principal);
  const { row, asset } = await loadReviewable(tx, principal, data.id, true);
  assertFresh(row, data.updatedAt);
  assertReview(row, asset);
  if (!row.secretFlag)
    throw new ConflictError("DOCSYNC_EXTRACT_NO_SECRET", "Bản trích không có dấu hiệu bí mật cần xác nhận.");
  const [saved] = await tx
    .update(docExtracts)
    .set({ secretFlag: false, updatedAt: new Date() })
    .where(eq(docExtracts.id, row.id))
    .returning();
  if (!saved) throw notFound();
  await recordAudit(tx, {
    action: "doc.secrets.acknowledge",
    actorUserId: userId,
    targetType: "doc_extract",
    targetId: row.id,
    data: { assetId: asset.id, repoPath: asset.repoPath, findings: scanSecrets(row.content) },
  });
  return detail(saved, asset);
}

/** Bản trích đã duyệt của một file, cho agent (FR-039). Bản ở trạng thái khác không bao giờ ra khỏi hub. */
export async function approvedExtractOf(tx: Tx, assetId: string): Promise<ExtractRow | null> {
  const [row] = await tx
    .select()
    .from(docExtracts)
    .where(and(eq(docExtracts.assetId, assetId), eq(docExtracts.state, "approved")));
  return row ?? null;
}

// ---- Job ----------------------------------------------------------------------------------------------------------

async function readBlob(tx: Tx, orgId: string, blobId: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of await createPostgresBlobStore().get(tx, orgId, blobId)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

type Prepared = { row: ExtractRow; asset: AssetRow; bytes: Uint8Array } | null;

async function failExtract(tx: Tx, id: string, message: string) {
  await tx
    .update(docExtracts)
    .set({ state: "failed", error: message, updatedAt: new Date() })
    .where(and(eq(docExtracts.id, id), eq(docExtracts.state, "pending")));
}

async function prepare(tx: Tx, job: { orgId: string; extractId: string }): Promise<Prepared> {
  const [row] = await tx.select().from(docExtracts).where(eq(docExtracts.id, job.extractId));
  if (row?.state !== "pending") return null;
  const [asset] = await tx.select().from(docAssets).where(eq(docAssets.id, row.assetId));
  if (!asset) return null;
  if (asset.sha256 !== row.sourceSha256) {
    await failExtract(tx, row.id, "Đã có bản trích mới hơn của file này.");
    return null;
  }
  if (asset.state !== "available" || !asset.blobId) {
    await failExtract(tx, row.id, "File chưa được lưu ở hub nên chưa trích được.");
    return null;
  }
  return { row, asset, bytes: await readBlob(tx, job.orgId, asset.blobId) };
}

async function notifyReview(tx: Tx, deps: DocSyncDeps, asset: AssetRow, extractId: string) {
  const [home] = await tx.select().from(docHomes).where(eq(docHomes.id, asset.homeId));
  if (!home) return;
  const project = home.projectId ? await loadProject(tx, home.projectId) : null;
  const recipientIds = project ? await teamMemberIds(tx, project.teamId, "admin") : await notificationRecipients(tx);
  if (!recipientIds.length) return;
  await notify(
    tx,
    {
      orgId: asset.orgId,
      event: "docsync.extract_review",
      title: `Bản trích ${asset.repoPath} chờ duyệt`,
      body: `${project ? `Dự án ${project.key}: ` : ""}nội dung trích từ file ${asset.repoPath} cần người xem lại trước khi agent và tìm kiếm dùng.`,
      eventKey: `docsync.extract_review:${extractId}`,
      recipientIds,
      link: deps.publicUrl ? `${deps.publicUrl.replace(/\/+$/, "")}/docs` : null,
    },
    { jobs: deps.jobs },
  );
}

/** Job `docsync-extract` cho một bản trích: đọc blob trong tenant, trích ngoài transaction, ghi kết quả. */
export async function runExtractJob(
  deps: ExtractDeps,
  job: { orgId: string; extractId: string },
): Promise<"review" | "failed" | "skipped"> {
  const ctx = { orgId: job.orgId };
  const prepared = await withTenant(deps.pool, ctx, (tx) => prepare(tx, job));
  if (!prepared) return "skipped";
  const { row, asset } = prepared;
  const kind = extractKind(asset.repoPath);
  // Luồng trích chạy tới 60 giây: không giữ transaction và kết nối trong lúc đó.
  const reply = kind
    ? await runExtract(kind, prepared.bytes, deps.run)
    : { ok: false as const, message: "Loại file này không trích được nội dung." };
  return withTenant(deps.pool, ctx, async (tx) => {
    if (!reply.ok) {
      await failExtract(tx, row.id, reply.message);
      return "failed";
    }
    const warnings = [...reply.warnings];
    let content = reply.markdown;
    if (content.length > DOC_MAX_CHARS) {
      content = content.slice(0, DOC_MAX_CHARS);
      warnings.push(`Bản trích dài quá ${DOC_MAX_CHARS} ký tự, đã cắt phần sau.`);
    }
    const [saved] = await tx
      .update(docExtracts)
      .set({
        content,
        warnings,
        state: "review",
        error: null,
        secretFlag: scanSecrets(content).length > 0,
        updatedAt: new Date(),
      })
      .where(and(eq(docExtracts.id, row.id), eq(docExtracts.state, "pending")))
      .returning({ id: docExtracts.id });
    if (!saved) return "skipped";
    await notifyReview(tx, deps, asset, row.id);
    return "review";
  });
}

/**
 * Cron: file đính kèm đổi nội dung (kéo từ repo, tải lên) thì tạo bản trích `pending` mới; bản đã duyệt giữ tới khi bản
 * mới được duyệt (FR-035). Bản chưa duyệt của nội dung cũ thành `failed`. Quét thay cho việc nối vào từng chỗ ghi file.
 */
export async function sweepExtracts(deps: ExtractDeps & { jobs: Jobs }): Promise<number> {
  const orgs = await withTenant(deps.pool, {}, async (tx) => {
    const { rows } = await tx.execute<{ org_id: string }>(sql`select org_id from hive.docsync_active_orgs()`);
    return rows.map((r) => r.org_id);
  });
  let queued = 0;
  for (const orgId of orgs) queued += await withTenant(deps.pool, { orgId }, (tx) => sweepOrg(tx, deps.jobs, orgId));
  return queued;
}

export async function sweepOrg(tx: Tx, jobs: Jobs, orgId: string): Promise<number> {
  const changed = await tx
    .select({ id: docAssets.id, sha256: docAssets.sha256 })
    .from(docAssets)
    .where(
      and(
        eq(docAssets.state, "available"),
        sql`${docAssets.repoPath} ~* ${EXTRACTABLE_SQL}`,
        sql`not exists (select 1 from ${docExtracts} e where e.asset_id = ${docAssets.id} and e.source_sha256 = ${docAssets.sha256})`,
      ),
    )
    .limit(SWEEP_BATCH);
  const queue: Array<{ assetId: string; extractId: string }> = [];
  for (const asset of changed) {
    await tx
      .update(docExtracts)
      .set({ state: "failed", error: "Đã có bản trích mới hơn của file này.", updatedAt: new Date() })
      .where(
        and(
          eq(docExtracts.assetId, asset.id),
          inArray(docExtracts.state, ["pending", "review"]),
          ne(docExtracts.sourceSha256, asset.sha256),
        ),
      );
    const [created] = await tx
      .insert(docExtracts)
      .values({ orgId, assetId: asset.id, sourceSha256: asset.sha256 })
      .returning({ id: docExtracts.id });
    if (created) queue.push({ assetId: asset.id, extractId: created.id });
  }
  const stale = await tx
    .select({ assetId: docExtracts.assetId, extractId: docExtracts.id })
    .from(docExtracts)
    .where(and(eq(docExtracts.state, "pending"), lt(docExtracts.updatedAt, new Date(Date.now() - STALE_PENDING_MS))))
    .limit(SWEEP_BATCH);
  for (const job of [...queue, ...stale])
    await jobs.enqueue(DOCSYNC_EXTRACT_QUEUE, { orgId, ...job } satisfies DocExtractJob, {
      tx,
      singletonKey: job.assetId,
    });
  return queue.length + stale.length;
}

export async function registerExtracts(jobs: Jobs, deps: DocSyncDeps): Promise<void> {
  const { pool } = deps;
  // Tiến trình chỉ gửi job (không có pool) thì không nhận việc.
  if (!pool) return;
  const full = { ...deps, pool, jobs };
  const handle = async ({ data }: { data: DocExtractJob }) => {
    if ("scan" in data) await sweepExtracts(full);
    else await runExtractJob(full, data);
  };
  // Hai luồng mỗi tiến trình (plan.md mục 9): mỗi luồng tới 512 MB heap, thêm nữa dễ làm đầy RAM của máy chủ nhỏ.
  await jobs.work<DocExtractJob>(DOCSYNC_EXTRACT_QUEUE, handle);
  await jobs.work<DocExtractJob>(DOCSYNC_EXTRACT_QUEUE, handle);
  await jobs.schedule(DOCSYNC_EXTRACT_QUEUE, DOCSYNC_EXTRACT_CRON, { scan: true } satisfies DocExtractJob);
}
