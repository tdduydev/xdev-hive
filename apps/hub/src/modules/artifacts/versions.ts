import { createHash } from "node:crypto";
import {
  type ArtifactOrigin,
  type ArtifactPublicLinkRevokeReason,
  type ArtifactType,
  type ArtifactVersion,
  type ArtifactVersionMeta,
  type OrgArtifactPolicy,
  scanSecrets,
} from "@xdev-hive/contracts";
import { and, desc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import type pg from "pg";
import { recordAudit } from "../audit/index.ts";
import { authUser } from "../identity/index.ts";
import { notify } from "../notify/index.ts";
import { type Jobs, type Tx, withTenant } from "../platform/index.ts";
import { artifactError, assertCan, audit, type Reader, readerUserId } from "./access.ts";
import { assertQuota, assertRunLimits, assertVersionSize, byteSize, lockOrgQuota, warnQuota } from "./limits.ts";
import { artifactPublicLinks, artifacts, artifactVersions } from "./schema.ts";

/*
 * Phiên bản bất biến (plan.md D3, FR-004…FR-007): mỗi lần lưu là một dòng mới, `artifacts.latest_version` là khoá lạc
 * quan. `hive_app` không có UPDATE/DELETE trên `artifact_versions`; đặt tên và xoá vì bí mật đi qua hàm SECURITY DEFINER.
 */

export type ArtifactRow = typeof artifacts.$inferSelect;
export type VersionRow = typeof artifactVersions.$inferSelect;

/** Mọi thao tác ghi cần thêm hai thứ ngoài transaction: hàng đợi (thông báo) và URL web (link trong thông báo). */
export interface ArtifactDeps {
  jobs?: Jobs | undefined;
  publicUrl?: string | undefined;
}

/** Kết quả biên dịch `react` (T014); loại khác luôn null cả hai. */
export interface Compiled {
  compiled: string | null;
  compileError: string | null;
}

const SEARCH_CHARS = 200_000;

/** Tiêu đề nặng hơn nội dung khi xếp hạng; nội dung chỉ lấy 200 000 ký tự đầu (D2 "Tìm chữ"). */
export const searchVector = (title: string | SQL, content: string | SQL | null) =>
  content === null
    ? sql`setweight(to_tsvector('simple', ${title}), 'A')`
    : sql`setweight(to_tsvector('simple', ${title}), 'A') || to_tsvector('simple', left(${content}, ${SEARCH_CHARS}))`;

// ---- Kiểm nội dung -------------------------------------------------------------------------------------------------

export function assertWritable(policy: OrgArtifactPolicy, type: ArtifactType): void {
  if (!policy.enabled) throw artifactError("ARTIFACTS_DISABLED");
  if (!policy.types.includes(type)) throw artifactError("ARTIFACT_TYPE_DISABLED");
}

/** Lỗi `ARTIFACT_SECRET_FOUND` mang theo artifact (nếu có) để lớp gọi ghi audit sau khi transaction đã huỷ. */
export type SecretBlockedError = ReturnType<typeof artifactError> & {
  secretBlocked: { artifactId: string | null; type: ArtifactType };
};

export const isSecretBlocked = (error: unknown): error is SecretBlockedError =>
  typeof error === "object" && error !== null && "secretBlocked" in error;

/** FR-120: có chuỗi giống bí mật thì chặn, trả dòng và loại, không bao giờ trả chuỗi (C11: không che tự động). */
export function assertNoSecrets(content: string, ctx: { artifactId: string | null; type: ArtifactType }): void {
  const findings = scanSecrets(content);
  if (findings.length === 0) return;
  const lines = [...new Set(findings.map((f) => f.line))].slice(0, 10).join(", ");
  const error = artifactError("ARTIFACT_SECRET_FOUND", `Có chuỗi giống bí mật ở dòng ${lines}. Xoá rồi lưu lại.`, {
    findings,
  }) as SecretBlockedError;
  error.secretBlocked = ctx;
  throw error;
}

/**
 * Audit `artifact.secret.blocked` (dòng, loại; không chuỗi). Transaction của thao tác đã huỷ vì lỗi nên ghi bằng
 * transaction riêng; ghi hỏng thì bỏ qua để người dùng vẫn nhận lỗi bí mật thay vì lỗi audit.
 */
export async function recordSecretBlocked(
  pool: pg.Pool,
  ctx: { orgId: string; userId: string | null; runId?: string | undefined },
  error: SecretBlockedError,
): Promise<void> {
  try {
    await withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId ?? undefined }, (tx) =>
      recordAudit(tx, {
        action: "artifact.secret.blocked",
        actorUserId: ctx.userId,
        targetType: "artifact",
        targetId: error.secretBlocked.artifactId ?? undefined,
        data: {
          type: error.secretBlocked.type,
          findings: error.detail?.findings ?? [],
          ...(ctx.runId ? { runId: ctx.runId } : {}),
        },
      }),
    );
  } catch (e) {
    console.error("Không ghi được audit artifact.secret.blocked:", e);
  }
}

// ---- Ghi phiên bản -------------------------------------------------------------------------------------------------

/** Tệp ảnh/PDF đã nằm trong `BlobStore`; phiên bản chỉ giữ tham chiếu (T062), nên `content` của dòng để null. */
export interface BlobInput {
  id: string;
  sha256: string;
  size: number;
}

export interface VersionInput {
  content: string;
  blob?: BlobInput | undefined;
  compiled: Compiled;
  origin: ArtifactOrigin;
  message?: string | null | undefined;
  restoredFrom?: number | null | undefined;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Dung lượng tính vào hạn mức: cỡ tệp với blob, ngược lại cỡ chữ cộng bản biên dịch. */
export const versionBytes = (input: Pick<VersionInput, "content" | "compiled" | "blob">): number =>
  input.blob ? input.blob.size : byteSize(input.content, input.compiled.compiled);

/** Kiểm cỡ và bí mật, trước mọi khoá (D13: biên dịch và quét chạy ngoài phần giữ khoá). */
export function checkContent(
  policy: OrgArtifactPolicy,
  type: ArtifactType,
  input: Pick<VersionInput, "content" | "compiled">,
  artifactId: string | null,
): number {
  assertWritable(policy, type);
  const bytes = byteSize(input.content, input.compiled.compiled);
  assertVersionSize(policy, byteSize(input.content));
  assertNoSecrets(input.content, { artifactId, type });
  return bytes;
}

function authorOf(reader: Reader): { authorUserId: string | null; authorRunId: string | null } {
  return reader.kind === "run"
    ? { authorUserId: null, authorRunId: reader.runId }
    : { authorUserId: reader.userId, authorRunId: null };
}

/** Khoá dung lượng và kiểm hạn mức, giới hạn run. Gọi trong transaction, trước khi khoá dòng artifact. */
export async function reserve(
  tx: Tx,
  reader: Reader,
  policy: OrgArtifactPolicy,
  bytes: number,
  opts: { newArtifact: boolean },
): Promise<number> {
  await lockOrgQuota(tx);
  const used = await assertQuota(tx, policy, bytes);
  if (reader.kind === "run") await assertRunLimits(tx, policy, reader.runId, opts);
  return used;
}

/** Thêm dòng phiên bản `version` và ghi audit `artifact.version`. Dòng artifact đã được cập nhật bởi người gọi. */
export async function insertVersion(
  tx: Tx,
  reader: Reader,
  artifact: ArtifactRow,
  version: number,
  input: VersionInput,
): Promise<VersionRow> {
  const bytes = versionBytes(input);
  const hash = input.blob ? input.blob.sha256 : sha256(input.content);
  const [row] = await tx
    .insert(artifactVersions)
    .values({
      orgId: artifact.orgId,
      artifactId: artifact.id,
      version,
      content: input.blob ? null : input.content,
      blobId: input.blob?.id ?? null,
      compiled: input.compiled.compiled,
      compileError: input.compiled.compileError,
      sha256: hash,
      sizeBytes: bytes,
      ...authorOf(reader),
      origin: input.origin,
      message: input.message ?? null,
      restoredFrom: input.restoredFrom ?? null,
    })
    .returning();
  if (!row) throw new Error("Không lưu được phiên bản artifact.");
  await audit(tx, reader, "artifact.version", artifact.id, {
    version,
    origin: input.origin,
    sizeBytes: bytes,
    sha256: hash,
    ...(input.restoredFrom ? { restoredFrom: input.restoredFrom } : {}),
  });
  return row;
}

/** Sau khi ghi: báo quản trị nếu dung lượng vượt 80% (FR-123). */
export async function afterWrite(
  tx: Tx,
  policy: OrgArtifactPolicy,
  usedBefore: number,
  bytes: number,
  orgId: string,
  deps: ArtifactDeps,
): Promise<void> {
  await warnQuota(tx, policy, usedBefore + bytes, { orgId, jobs: deps.jobs, publicUrl: deps.publicUrl });
}

/**
 * Phiên bản mới cho artifact đã có (FR-005). Khoá dòng artifact rồi mới so `baseVersion`, nên hai lần lưu cùng từ một
 * bản thì một lần nhận `ARTIFACT_VERSION_CONFLICT` kèm bản mới nhất. Thiếu `baseVersion` chỉ nhận khi người gọi viết bản
 * mới nhất (agent sửa liên tiếp bản của chính nó).
 */
export async function appendVersion(
  tx: Tx,
  reader: Reader,
  policy: OrgArtifactPolicy,
  id: string,
  input: VersionInput & { baseVersion?: number | undefined; title?: string | undefined },
  deps: ArtifactDeps,
): Promise<{ artifact: ArtifactRow; version: VersionRow }> {
  const bytes = versionBytes(input);
  const used = await reserve(tx, reader, policy, bytes, { newArtifact: false });
  const [locked] = await tx.select().from(artifacts).where(eq(artifacts.id, id)).for("update");
  if (!locked || locked.deletedAt) throw artifactError("ARTIFACT_NOT_FOUND");
  await assertCan(tx, reader, locked, "write");
  const latest = await versionRow(tx, id, locked.latestVersion);
  const author = authorOf(reader);
  const stale =
    input.baseVersion === undefined
      ? !latest ||
        (author.authorUserId !== null
          ? latest.authorUserId !== author.authorUserId
          : latest.authorRunId !== author.authorRunId)
      : input.baseVersion !== locked.latestVersion;
  if (stale) {
    throw artifactError(
      "ARTIFACT_VERSION_CONFLICT",
      input.baseVersion === undefined
        ? `Artifact đã ở phiên bản ${locked.latestVersion} do người khác lưu. Gửi kèm baseVersion sau khi đọc bản mới nhất.`
        : `Artifact đã ở phiên bản ${locked.latestVersion}, bạn sửa từ phiên bản ${input.baseVersion}. Đọc bản mới nhất, gộp thay đổi rồi lưu lại.`,
      { latest: { version: locked.latestVersion, content: latest?.content ?? null } },
    );
  }
  if (locked.latestVersion >= policy.maxVersions)
    throw artifactError("ARTIFACT_VERSION_LIMIT", undefined, { limit: policy.maxVersions });
  const next = locked.latestVersion + 1;
  const title = input.title ?? locked.title;
  const [artifact] = await tx
    .update(artifacts)
    .set({
      latestVersion: next,
      title,
      sizeBytes: sql`${artifacts.sizeBytes} + ${bytes}`,
      search: searchVector(title, input.blob ? null : input.content),
      updatedAt: sql`now()`,
    })
    .where(eq(artifacts.id, id))
    .returning();
  if (!artifact) throw artifactError("ARTIFACT_NOT_FOUND");
  if (input.title !== undefined && input.title !== locked.title)
    await audit(tx, reader, "artifact.rename", id, { version: next });
  const version = await insertVersion(tx, reader, artifact, next, input);
  await afterWrite(tx, policy, used, bytes, artifact.orgId, deps);
  return { artifact, version };
}

// ---- Đọc -----------------------------------------------------------------------------------------------------------

export async function versionRow(tx: Tx, artifactId: string, version: number): Promise<VersionRow | null> {
  const [row] = await tx
    .select()
    .from(artifactVersions)
    .where(and(eq(artifactVersions.artifactId, artifactId), eq(artifactVersions.version, version)));
  return row ?? null;
}

export async function userNames(tx: Tx, ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (wanted.length === 0) return new Map();
  const rows = await tx
    .select({ id: authUser.id, name: authUser.name })
    .from(authUser)
    .where(inArray(authUser.id, wanted));
  return new Map(rows.map((r) => [r.id, r.name]));
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function versionMeta(row: VersionRow, names: Map<string, string>): ArtifactVersionMeta {
  return {
    version: row.version,
    sha256: row.sha256,
    sizeBytes: row.sizeBytes,
    hasBlob: row.blobId !== null,
    authorUser: row.authorUserId
      ? { id: row.authorUserId, name: names.get(row.authorUserId) ?? row.authorUserId }
      : null,
    authorRunId: row.authorRunId,
    origin: row.origin,
    message: row.message,
    name: row.name,
    restoredFrom: row.restoredFrom,
    hasCompileError: row.compileError !== null,
    tombstonedAt: iso(row.tombstonedAt),
    createdAt: row.createdAt.toISOString(),
  };
}

export function versionView(row: VersionRow, names: Map<string, string>): ArtifactVersion {
  return { ...versionMeta(row, names), content: row.content, compileError: row.compileError };
}

export async function metaOf(tx: Tx, row: VersionRow): Promise<ArtifactVersionMeta> {
  return versionMeta(row, await userNames(tx, [row.authorUserId]));
}

async function artifactRow(tx: Tx, id: string, lock = false): Promise<ArtifactRow> {
  const q = tx.select().from(artifacts).where(eq(artifacts.id, id));
  const [row] = lock ? await q.for("update") : await q;
  if (!row) throw artifactError("ARTIFACT_NOT_FOUND");
  return row;
}

export async function listVersions(tx: Tx, reader: Reader, id: string): Promise<ArtifactVersionMeta[]> {
  const row = await artifactRow(tx, id);
  await assertCan(tx, reader, row, row.deletedAt ? "manage" : "read");
  const rows = await tx
    .select()
    .from(artifactVersions)
    .where(eq(artifactVersions.artifactId, id))
    .orderBy(desc(artifactVersions.version));
  const names = await userNames(
    tx,
    rows.map((r) => r.authorUserId),
  );
  return rows.map((r) => versionMeta(r, names));
}

async function liveVersion(tx: Tx, reader: Reader, id: string, version: number, action: "write" | "manage") {
  const row = await artifactRow(tx, id, true);
  if (row.deletedAt) throw artifactError("ARTIFACT_NOT_FOUND");
  await assertCan(tx, reader, row, action);
  const v = await versionRow(tx, id, version);
  if (!v) throw artifactError("ARTIFACT_NOT_FOUND", "Không tìm thấy phiên bản này.");
  return { row, v };
}

/** Đặt hoặc bỏ tên phiên bản (FR-006) qua `hive.artifact_version_rename`; không tạo phiên bản. */
export async function renameVersion(
  tx: Tx,
  reader: Reader,
  input: { id: string; version: number; name: string | null },
): Promise<ArtifactVersionMeta> {
  const { v } = await liveVersion(tx, reader, input.id, input.version, "write");
  await tx.execute(sql`select hive.artifact_version_rename(${v.id}::uuid, ${input.name})`);
  const after = await versionRow(tx, input.id, input.version);
  if (!after) throw artifactError("ARTIFACT_NOT_FOUND");
  return metaOf(tx, after);
}

/**
 * "Xoá phiên bản" vì lộ bí mật (FR-007): bỏ nội dung, giữ số và tác giả; link công khai của bản đó bị thu hồi trong cùng
 * transaction. Dung lượng trả lại cho tổ chức; bản mới nhất bị xoá thì bỏ nội dung khỏi chỉ mục tìm.
 */
export async function tombstoneVersion(
  tx: Tx,
  reader: Reader,
  input: { id: string; version: number },
  deps: ArtifactDeps,
): Promise<ArtifactVersionMeta> {
  const { row, v } = await liveVersion(tx, reader, input.id, input.version, "manage");
  if (v.tombstonedAt) return metaOf(tx, v);
  await tx.execute(sql`select hive.artifact_tombstone(${v.id}::uuid)`);
  await tx
    .update(artifacts)
    .set({
      sizeBytes: sql`greatest(${artifacts.sizeBytes} - ${v.sizeBytes}, 0)`,
      ...(row.latestVersion === v.version ? { search: searchVector(row.title, null) } : {}),
    })
    .where(eq(artifacts.id, row.id));
  const revoked = await revokePublicLinks(
    tx,
    reader,
    row,
    and(eq(artifactPublicLinks.artifactId, row.id), eq(artifactPublicLinks.version, v.version)) as SQL,
    "tombstoned",
    deps,
  );
  await audit(tx, reader, "artifact.version.tombstone", row.id, { version: v.version, revokedLinks: revoked });
  const after = await versionRow(tx, input.id, input.version);
  if (!after) throw artifactError("ARTIFACT_NOT_FOUND");
  return metaOf(tx, after);
}

// ---- Link công khai ------------------------------------------------------------------------------------------------

/**
 * Thu hồi link công khai còn hiệu lực theo sự kiện (xoá, chuyển chủ, tombstone, chủ rời tổ chức; D21) trong transaction
 * của sự kiện. Báo chủ khi người khác (hay hệ thống) làm link hết hiệu lực; tự hết hạn thì không báo.
 */
export async function revokePublicLinks(
  tx: Tx,
  reader: Reader | null,
  artifact: Pick<ArtifactRow, "id" | "orgId" | "ownerUserId" | "title">,
  where: SQL,
  reason: ArtifactPublicLinkRevokeReason,
  deps: ArtifactDeps,
): Promise<number> {
  const by = reader ? readerUserId(reader) : null;
  const rows = await tx
    .update(artifactPublicLinks)
    .set({ revokedAt: sql`now()`, revokedBy: by, revokeReason: reason })
    .where(and(where, isNull(artifactPublicLinks.revokedAt), sql`${artifactPublicLinks.expiresAt} > now()`))
    .returning({ id: artifactPublicLinks.id, version: artifactPublicLinks.version });
  if (rows.length === 0) return 0;
  await recordAudit(tx, {
    action: "artifact.public_link.revoke",
    actorUserId: by,
    targetType: "artifact",
    targetId: artifact.id,
    data: { reason, links: rows.map((r) => ({ id: r.id, version: r.version })) },
  });
  if (by !== artifact.ownerUserId) {
    await notify(
      tx,
      {
        orgId: artifact.orgId,
        event: "artifact.public_link.revoked",
        recipientIds: [artifact.ownerUserId],
        title: `Link công khai của "${artifact.title}" đã bị thu hồi`,
        body: `${rows.length} link công khai không còn mở được (${REVOKE_REASON_TEXT[reason]}).`,
        link: deps.publicUrl ? `${deps.publicUrl.replace(/\/+$/, "")}/artifacts/${artifact.id}` : null,
      },
      { jobs: deps.jobs },
    );
  }
  return rows.length;
}

const REVOKE_REASON_TEXT: Record<ArtifactPublicLinkRevokeReason, string> = {
  manual: "thu hồi tay",
  deleted: "artifact bị xoá",
  owner_changed: "artifact đổi chủ",
  tombstoned: "phiên bản bị xoá vì bí mật",
  owner_left: "chủ đã rời tổ chức",
  org_disabled: "tổ chức tắt link công khai",
};
