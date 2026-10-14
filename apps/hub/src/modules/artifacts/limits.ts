import {
  ARTIFACT_LIMITS,
  type ArtifactSettings,
  DEFAULT_ORG_ARTIFACT_POLICY,
  type OrgArtifactPolicy,
} from "@xdev-hive/contracts";
import { and, count, eq, isNotNull, sql } from "drizzle-orm";
import { auditByData, recordAudit } from "../audit/index.ts";
import { loadPolicy } from "../governance/index.ts";
import { notify } from "../notify/index.ts";
import type { Jobs, Tx } from "../platform/index.ts";
import { notificationRecipients } from "../tenancy/index.ts";
import { artifactError } from "./access.ts";
import { artifacts, artifactVersions } from "./schema.ts";

/*
 * Giới hạn của artifact (plan.md D13, FR-003, FR-123). Người vận hành đặt trần bằng biến môi trường vì hub tự host trên
 * một máy; chính sách tổ chức chỉ hạ được dưới trần đó.
 */

const MIB = 1024 * 1024;

export interface OperatorCeilings {
  maxVersionBytes: number;
  maxBlobBytes: number;
  orgQuotaBytes: number;
  /** Hạn tối đa của link công khai (T015 dùng). */
  linkMaxDays: number;
}

function positiveInt(raw: string | undefined, fallback: number, ceiling: number): number {
  const n = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return Math.min(n, ceiling);
}

/** Đọc trần từ `HIVE_ARTIFACT_*`; giá trị sai hay trống thì dùng mặc định C10, quá trần cứng thì hạ về trần cứng. */
export function operatorCeilings(env: Record<string, string | undefined> = process.env): OperatorCeilings {
  return {
    maxVersionBytes: positiveInt(
      env.HIVE_ARTIFACT_MAX_VERSION_BYTES,
      ARTIFACT_LIMITS.defaultVersionBytes,
      ARTIFACT_LIMITS.versionBytesCeiling,
    ),
    maxBlobBytes: positiveInt(
      env.HIVE_ARTIFACT_MAX_BLOB_BYTES,
      ARTIFACT_LIMITS.defaultBlobBytes,
      ARTIFACT_LIMITS.blobBytesCeiling,
    ),
    orgQuotaBytes: positiveInt(
      env.HIVE_ARTIFACT_ORG_QUOTA_BYTES,
      ARTIFACT_LIMITS.defaultOrgQuotaBytes,
      ARTIFACT_LIMITS.orgQuotaBytesCeiling,
    ),
    linkMaxDays: positiveInt(
      env.HIVE_ARTIFACT_LINK_MAX_DAYS,
      ARTIFACT_LIMITS.publicLinkMaxDays,
      ARTIFACT_LIMITS.publicLinkMaxDays,
    ),
  };
}

/** Chính sách đang áp = chính sách tổ chức đã hạ về trần người vận hành. */
export function clampPolicy(policy: OrgArtifactPolicy, ceilings: OperatorCeilings): OrgArtifactPolicy {
  return {
    ...policy,
    maxVersionBytes: Math.min(policy.maxVersionBytes, ceilings.maxVersionBytes),
    maxBlobBytes: Math.min(policy.maxBlobBytes, ceilings.maxBlobBytes),
    orgQuotaBytes: Math.min(policy.orgQuotaBytes, ceilings.orgQuotaBytes),
    publicLinks: { ...policy.publicLinks, maxDays: Math.min(policy.publicLinks.maxDays, ceilings.linkMaxDays) },
  };
}

export async function artifactPolicyOf(tx: Tx, ceilings = operatorCeilings()): Promise<OrgArtifactPolicy> {
  return clampPolicy((await loadPolicy(tx)).artifacts ?? DEFAULT_ORG_ARTIFACT_POLICY, ceilings);
}

export function settingsView(policy: OrgArtifactPolicy): ArtifactSettings {
  return {
    enabled: policy.enabled,
    types: policy.types,
    scopes: policy.scopes,
    maxVersionBytes: policy.maxVersionBytes,
    maxVersions: policy.maxVersions,
    publicLinks: policy.publicLinks,
  };
}

export const formatBytes = (n: number) =>
  n >= MIB ? `${(n / MIB).toFixed(1).replace(".", ",")} MiB` : `${Math.ceil(n / 1024)} KiB`;

/** Cỡ tính dung lượng: byte UTF-8 của nội dung và bản biên dịch. */
export const byteSize = (...parts: (string | null | undefined)[]) =>
  parts.reduce((sum, p) => sum + (p ? Buffer.byteLength(p, "utf8") : 0), 0);

export function assertVersionSize(policy: OrgArtifactPolicy, bytes: number): void {
  if (bytes > policy.maxVersionBytes)
    throw artifactError(
      "ARTIFACT_TOO_LARGE",
      `Artifact quá lớn (${formatBytes(bytes)} > ${formatBytes(policy.maxVersionBytes)}).`,
      { limit: policy.maxVersionBytes },
    );
}

/**
 * Hai lần lưu cùng lúc của một tổ chức nối đuôi nhau, nên tổng dung lượng kiểm trong transaction không bị vượt (D13).
 * Ghi artifact thưa nên khoá theo tổ chức không đáng kể.
 */
export async function lockOrgQuota(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('artifact-quota:' || hive.ctx_org()::text, 0))`);
}

/** Dung lượng đã dùng của tổ chức, cả thùng rác (D13). */
export async function orgUsedBytes(tx: Tx): Promise<number> {
  const [row] = await tx.select({ used: sql<string>`coalesce(sum(${artifacts.sizeBytes}), 0)` }).from(artifacts);
  return Number(row?.used ?? 0);
}

/** Gọi sau `lockOrgQuota`. Trả dung lượng trước khi thêm để báo 80%. */
export async function assertQuota(tx: Tx, policy: OrgArtifactPolicy, addBytes: number): Promise<number> {
  const used = await orgUsedBytes(tx);
  if (used + addBytes > policy.orgQuotaBytes)
    throw artifactError(
      "ARTIFACT_QUOTA_EXCEEDED",
      `Tổ chức đã dùng ${formatBytes(used)} / ${formatBytes(policy.orgQuotaBytes)} dung lượng artifact. Xoá bớt artifact cũ hoặc nhờ quản trị tăng hạn mức.`,
      { limit: policy.orgQuotaBytes },
    );
  return used;
}

/** Giới hạn mỗi run (FR-003): số artifact run tạo và số phiên bản run viết, đếm theo `author_run_id`. */
export async function assertRunLimits(
  tx: Tx,
  policy: OrgArtifactPolicy,
  runId: string,
  opts: { newArtifact: boolean },
): Promise<void> {
  const byRun = and(isNotNull(artifactVersions.authorRunId), eq(artifactVersions.authorRunId, runId));
  const [versions] = await tx.select({ n: count() }).from(artifactVersions).where(byRun);
  if ((versions?.n ?? 0) >= policy.runLimits.versions)
    throw artifactError(
      "ARTIFACT_RUN_LIMIT",
      `Run đã viết ${policy.runLimits.versions} phiên bản artifact, mức tối đa cho một run.`,
      { limit: policy.runLimits.versions },
    );
  if (!opts.newArtifact) return;
  const [created] = await tx
    .select({ n: count() })
    .from(artifactVersions)
    .where(and(byRun, eq(artifactVersions.version, 1)));
  if ((created?.n ?? 0) >= policy.runLimits.artifacts)
    throw artifactError(
      "ARTIFACT_RUN_LIMIT",
      `Run đã tạo ${policy.runLimits.artifacts} artifact, mức tối đa cho một run. Sửa artifact đã có bằng artifact_update.`,
      { limit: policy.runLimits.artifacts },
    );
}

const QUOTA_WARN_RATIO = 0.8;

/**
 * FR-123: báo quản trị tổ chức khi dung lượng vượt 80%, tối đa một lần mỗi ngày (UTC). Dấu "đã báo hôm nay" là một dòng
 * audit, kiểm dưới khoá dung lượng nên hai lần lưu cùng lúc không báo hai lần.
 */
export async function warnQuota(
  tx: Tx,
  policy: OrgArtifactPolicy,
  usedBytes: number,
  opts: { orgId: string; jobs?: Jobs | undefined; publicUrl?: string | undefined },
): Promise<boolean> {
  if (usedBytes < policy.orgQuotaBytes * QUOTA_WARN_RATIO) return false;
  const day = new Date().toISOString().slice(0, 10);
  const done = await auditByData(tx, { actionLike: "artifact.quota.warn", key: "day", value: day, limit: 1 });
  if (done.length > 0) return false;
  const percent = Math.floor((usedBytes / policy.orgQuotaBytes) * 100);
  await recordAudit(tx, {
    action: "artifact.quota.warn",
    actorUserId: null,
    targetType: "org",
    data: { day, usedBytes, quotaBytes: policy.orgQuotaBytes },
  });
  const admins = await notificationRecipients(tx);
  await notify(
    tx,
    {
      orgId: opts.orgId,
      event: "artifact.quota",
      eventKey: `artifact.quota:${day}`,
      recipientIds: admins,
      title: `Artifact đã dùng ${percent}% dung lượng`,
      body: `Tổ chức đã dùng ${formatBytes(usedBytes)} / ${formatBytes(policy.orgQuotaBytes)} dung lượng artifact. Khi đầy, agent và người dùng sẽ không lưu được artifact mới.`,
      link: opts.publicUrl ? `${opts.publicUrl.replace(/\/+$/, "")}/artifacts` : null,
    },
    { jobs: opts.jobs },
  );
  return true;
}
