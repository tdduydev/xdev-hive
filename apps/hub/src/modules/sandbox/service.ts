import {
  type AllowlistEntry,
  type EffectiveAllowlist,
  type EnvImage,
  egressRule,
  envImageInput,
  normalizeEgressRule,
  type SandboxJobConfig,
  type SandboxOrgSettings,
  SUGGESTED_EGRESS_RULES,
} from "@xdev-hive/contracts";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { findProject, type ProjectRef } from "../catalog/index.ts";
import { ConflictError, NotFoundError, type Tx } from "../platform/index.ts";
import { requireOrgRole, requireTeamRole, teamRoleOf } from "../tenancy/index.ts";
import { egressAllowlists, envImages, sandboxOrgSettings } from "./schema.ts";

const defaults: SandboxOrgSettings = { locked: false, useSuggestedDefaults: false };
const entryView = (r: typeof egressAllowlists.$inferSelect): AllowlistEntry => ({
  id: r.id,
  projectId: r.projectId,
  rule: r.rule,
  note: r.note,
  addedBy: r.addedBy,
  createdAt: r.createdAt.toISOString(),
});
const imageView = (r: typeof envImages.$inferSelect): EnvImage => ({
  projectId: r.projectId,
  baseImage: r.baseImage,
  setupScriptHash: r.setupScriptHash,
  updatedAt: r.updatedAt.toISOString(),
});

async function projectFor(tx: Tx, userId: string, projectId: string, write = false): Promise<ProjectRef> {
  const p = await findProject(tx, projectId);
  if (!p || !(await teamRoleOf(tx, userId, p.teamId))) {
    throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án trong tổ chức.");
  }
  await requireTeamRole(tx, userId, p.teamId, write ? "admin" : "viewer");
  return p;
}

async function scopeFor(tx: Tx, userId: string, projectId?: string, write = false) {
  if (projectId) return projectFor(tx, userId, projectId, write);
  await requireOrgRole(tx, userId, write ? "admin" : "member");
  return null;
}

/** Khoá chung cả khi cấu hình chưa tồn tại để khoá tổ chức và thêm mục dự án không lọt qua nhau. */
async function lockPolicy(tx: Tx, shared = false) {
  await tx.execute(
    sql`select ${shared ? sql`pg_advisory_xact_lock_shared` : sql`pg_advisory_xact_lock`}(hashtextextended('sandbox:policy:' || hive.ctx_org()::text, 0))`,
  );
}

async function readSettings(tx: Tx): Promise<SandboxOrgSettings> {
  const [row] = await tx.select().from(sandboxOrgSettings);
  return row ? { locked: row.locked, useSuggestedDefaults: row.useSuggestedDefaults } : { ...defaults };
}

export async function getOrgSettings(tx: Tx, userId: string) {
  await requireOrgRole(tx, userId, "member");
  return readSettings(tx);
}

export async function updateOrgSettings(tx: Tx, userId: string, settings: SandboxOrgSettings) {
  await requireOrgRole(tx, userId, "admin");
  await lockPolicy(tx);
  const before = await readSettings(tx);
  await tx
    .insert(sandboxOrgSettings)
    .values({ orgId: sql`hive.ctx_org()`, ...settings })
    .onConflictDoUpdate({ target: sandboxOrgSettings.orgId, set: settings });
  await recordAudit(tx, {
    action: "sandbox.settings.update",
    targetType: "organization",
    data: { before, after: settings },
  });
  return settings;
}

const inScope = (projectId?: string) =>
  projectId ? eq(egressAllowlists.projectId, projectId) : isNull(egressAllowlists.projectId);
export async function listAllowlist(tx: Tx, userId: string, projectId?: string) {
  await scopeFor(tx, userId, projectId);
  return (
    await tx
      .select()
      .from(egressAllowlists)
      .where(inScope(projectId))
      .orderBy(asc(egressAllowlists.createdAt), asc(egressAllowlists.id))
  ).map(entryView);
}

export async function addAllowlist(
  tx: Tx,
  userId: string,
  input: { projectId?: string | undefined; rule: string; note?: string | undefined },
) {
  const project = await scopeFor(tx, userId, input.projectId, true);
  const rule = normalizeEgressRule(egressRule.parse(input.rule));
  if (!rule) throw new Error("Không chuẩn hoá được mục mạng.");
  await lockPolicy(tx);
  if (project && (await readSettings(tx)).locked) {
    throw new ConflictError("ALLOWLIST_LOCKED", "Tổ chức đã khoá allowlist, dự án không được mở thêm mạng.");
  }
  const [row] = await tx
    .insert(egressAllowlists)
    .values({
      orgId: sql`hive.ctx_org()`,
      teamId: project?.teamId ?? null,
      projectId: project?.id ?? null,
      rule,
      note: input.note ?? null,
      addedBy: userId,
    })
    .returning();
  if (!row) throw new Error("Không ghi được mục mạng.");
  await recordAudit(tx, {
    action: "sandbox.allowlist.add",
    targetType: "egress_allowlist",
    targetId: row.id,
    data: entryView(row),
  });
  return entryView(row);
}

export async function removeAllowlist(
  tx: Tx,
  userId: string,
  input: { entryId: string; projectId?: string | undefined },
) {
  await scopeFor(tx, userId, input.projectId, true);
  await lockPolicy(tx);
  const [row] = await tx
    .delete(egressAllowlists)
    .where(and(eq(egressAllowlists.id, input.entryId), inScope(input.projectId)))
    .returning();
  if (!row) throw new NotFoundError("ALLOWLIST_ENTRY_NOT_FOUND", "Không tìm thấy mục mạng trong phạm vi này.");
  await recordAudit(tx, {
    action: "sandbox.allowlist.remove",
    targetType: "egress_allowlist",
    targetId: row.id,
    data: entryView(row),
  });
  return { removed: true as const };
}

async function readEffective(tx: Tx, projectId: string): Promise<EffectiveAllowlist> {
  const settings = await readSettings(tx);
  const rows = await tx
    .select()
    .from(egressAllowlists)
    .where(
      settings.locked
        ? isNull(egressAllowlists.projectId)
        : or(isNull(egressAllowlists.projectId), eq(egressAllowlists.projectId, projectId)),
    )
    .orderBy(asc(egressAllowlists.createdAt), asc(egressAllowlists.id));
  const rules = [
    ...new Set([
      ...(settings.useSuggestedDefaults ? SUGGESTED_EGRESS_RULES : []),
      ...rows.map((r) => egressRule.parse(r.rule)),
    ]),
  ];
  return { ...settings, rules, suggestedRules: [...SUGGESTED_EGRESS_RULES] };
}

export async function getEffectiveAllowlist(tx: Tx, userId: string, projectId: string) {
  await projectFor(tx, userId, projectId);
  await lockPolicy(tx, true);
  return readEffective(tx, projectId);
}

async function readImage(tx: Tx, projectId: string) {
  const [row] = await tx.select().from(envImages).where(eq(envImages.projectId, projectId));
  return row ? imageView(row) : null;
}
export async function getImage(tx: Tx, userId: string, projectId: string) {
  await projectFor(tx, userId, projectId);
  return readImage(tx, projectId);
}
export async function setImage(
  tx: Tx,
  userId: string,
  input: { projectId: string; baseImage: string; setupScriptHash: string },
) {
  const p = await projectFor(tx, userId, input.projectId, true);
  const config = envImageInput.parse(input);
  const [row] = await tx
    .insert(envImages)
    .values({ orgId: sql`hive.ctx_org()`, teamId: p.teamId, projectId: p.id, ...config, updatedBy: userId })
    .onConflictDoUpdate({ target: envImages.projectId, set: { ...config, updatedBy: userId, updatedAt: sql`now()` } })
    .returning();
  if (!row) throw new Error("Không ghi được image môi trường.");
  await recordAudit(tx, { action: "sandbox.image.set", targetType: "project", targetId: p.id, data: config });
  return imageView(row);
}

/** Runs đã kiểm quyền; khoá chính sách tới commit để snapshot không trộn hai phiên bản cấu hình tổ chức. */
export async function loadSandboxJobConfig(tx: Tx, projectId: string): Promise<SandboxJobConfig> {
  await lockPolicy(tx, true);
  const image = await readImage(tx, projectId);
  if (!image) throw new ConflictError("SANDBOX_IMAGE_REQUIRED", "Dự án chưa cấu hình image môi trường cho sandbox.");
  const effective = await readEffective(tx, projectId);
  return { allowlist: effective.rules, image: { baseImage: image.baseImage, setupScriptHash: image.setupScriptHash } };
}
