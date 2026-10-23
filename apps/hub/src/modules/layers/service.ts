import { CONFIG_SCHEMA_VERSION, type EffectiveConfig, type LayerEntry, type teamSetInput } from "@xdev-hive/contracts";
import { and, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import { recordAudit } from "../audit/index.ts";
import { loadProject } from "../catalog/index.ts";
import { loadPolicy } from "../governance/index.ts";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, type Tx } from "../platform/index.ts";
import { allowWith, effectivePermissions, requireOrgRole, requireTeamRole, teamRoleOf } from "../tenancy/index.ts";
import { configVersion, type LayerInput, rankOf, resolveConfig, withoutChain } from "./engine.ts";
import { findSetting, type SettingDef } from "./registry.ts";
import { configLayerEntries as entries } from "./schema.ts";
import { buildLayers, orgValuesFromPolicy, type StoredEntry } from "./sources.ts";

type Row = typeof entries.$inferSelect;
const view = (r: Row): LayerEntry => ({
  layer: r.layer,
  targetId: r.targetId,
  key: r.key,
  value: r.value,
  locked: r.locked,
  version: r.version,
  updatedBy: r.updatedBy,
  updatedAt: r.updatedAt.toISOString(),
});
const stored = (r: Row): StoredEntry => ({
  layer: r.layer,
  targetId: r.targetId,
  key: r.key,
  value: r.value,
  locked: r.locked,
});

async function ctxOrg(tx: Tx): Promise<string> {
  const { rows } = await tx.execute<{ org: string }>(sql`select hive.ctx_org()::text as org`);
  const org = rows[0]?.org;
  if (!org) throw new Error("Thiếu tổ chức trong context.");
  return org;
}

function defOf(key: string): SettingDef {
  const def = findSetting(key);
  if (!def) throw new BadRequestError("CONFIG_UNKNOWN_KEY", `Không có cài đặt “${key}”.`);
  return def;
}

/** Khoá chỉ có nghĩa với cài đặt ghi đè và cộng dồn; trần vốn đã một chiều (FR-021). */
function checkLockable(def: SettingDef) {
  if (def.kind === "ceiling")
    throw new BadRequestError(
      "CONFIG_LAYER_NOT_ALLOWED",
      "Cài đặt dạng trần không cần khoá: tầng dưới không nới được.",
    );
}

/** Cấu hình hiệu lực của một dự án. Người xem dự án nào cũng đọc được; chuỗi tầng chỉ cho người sửa được cài đặt dự án. */
export async function effectiveConfig(tx: Tx, userId: string, projectId: string): Promise<EffectiveConfig> {
  const project = await loadProject(tx, projectId);
  const role = project && (await teamRoleOf(tx, userId, project.teamId));
  // Không có quyền xem thì NOT_FOUND để không lộ dự án có tồn tại.
  if (!project || !role) throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án.");
  const orgId = await ctxOrg(tx);
  const [policy, rows] = await Promise.all([loadPolicy(tx), tx.select().from(entries)]);
  const resolved = resolveConfig(
    buildLayers({
      orgId,
      teamId: project.teamId,
      projectId,
      policy,
      settings: project.settings,
      entries: rows.map(stored),
    }),
  );
  const canSeeChain = role === "admin" || role === "member";
  return {
    orgId,
    projectId,
    schemaVersion: CONFIG_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    configVersion: configVersion(orgId, resolved),
    settings: canSeeChain ? resolved : resolved.map(withoutChain),
  };
}

export async function teamEntries(tx: Tx, userId: string, teamId: string): Promise<LayerEntry[]> {
  await requireTeamRole(tx, userId, teamId, "viewer");
  const rows = await tx
    .select()
    .from(entries)
    .where(and(eq(entries.layer, "team"), eq(entries.targetId, teamId)));
  return rows.map(view);
}

const loosens = (def: SettingDef, from: unknown, to: unknown) =>
  def.kind === "ceiling" && rankOf(def.rule, to) > rankOf(def.rule, from);

/** Giá trị trần mà các tầng ngoài đội áp lên khoá này; undefined nếu chưa tầng nào đặt. */
function outerCeiling(def: SettingDef, layers: LayerInput[]): { value: unknown } | undefined {
  const r = resolveConfig(layers).find((x) => x.key === def.key);
  return r?.source ? { value: r.value } : undefined;
}

/** Đặt, đổi hoặc gỡ giá trị của đội (FR-030..033). `value` null là gỡ, vắng mặt là giữ giá trị cũ (chỉ đổi khoá). */
export async function setTeamEntry(
  tx: Tx,
  userId: string,
  input: z.output<typeof teamSetInput>,
): Promise<LayerEntry | null> {
  const def = defOf(input.key);
  if (!def.layers.includes("team"))
    throw new BadRequestError("CONFIG_LAYER_NOT_ALLOWED", "Cài đặt này không đặt được ở cấp đội.");
  await allowWith(tx, userId, "policies.write", () => requireTeamRole(tx, userId, input.teamId, "admin"), input.teamId);
  if (input.locked) checkLockable(def);

  const orgId = await ctxOrg(tx);
  const [policy, rows] = await Promise.all([loadPolicy(tx), tx.select().from(entries)]);
  const orgRows = rows.filter((r) => r.layer === "org" && r.targetId === orgId);
  if (def.kind !== "ceiling" && orgRows.some((r) => r.key === def.key && r.locked))
    throw new ConflictError("CONFIG_LOCKED", "Công ty đã khoá cài đặt này, đội không đổi được.");

  const prev = rows.find((r) => r.layer === "team" && r.targetId === input.teamId && r.key === def.key);
  if (input.expectedVersion !== undefined && (prev?.version ?? 0) !== input.expectedVersion)
    throw new ConflictError("CONFIG_VERSION_CONFLICT", "Cấu hình vừa được người khác sửa. Hãy tải lại rồi thử lại.");

  const nextValue = input.value === undefined ? (prev?.value ?? null) : input.value;
  if (nextValue !== null && !def.schema.safeParse(nextValue).success)
    throw new BadRequestError("CONFIG_VALUE_INVALID", `Giá trị của “${def.key}” không hợp lệ.`);
  const nextLocked = input.locked ?? prev?.locked ?? false;

  const orgLayer: LayerInput = {
    layer: "org",
    targetId: orgId,
    values: {
      ...orgValuesFromPolicy(policy),
      ...Object.fromEntries(orgRows.filter((r) => r.value !== null).map((r) => [r.key, r.value])),
    },
  };
  const outer = outerCeiling(def, [orgLayer]);
  if (nextValue !== null && outer && loosens(def, outer.value, nextValue))
    throw new ConflictError("CONFIG_ABOVE_CEILING", "Giá trị này rộng hơn trần của công ty.");
  if (def.dangerous && nextValue !== null) {
    const before = prev?.value ?? outer?.value ?? def.default;
    if (
      loosens(def, before, nextValue) &&
      !(await effectivePermissions(tx, userId, input.teamId)).has("policies.fullaccess")
    )
      throw new ForbiddenError("CONFIG_FULLACCESS_REQUIRED", "Cần quyền “Cho phép CLI toàn quyền” để nới cài đặt này.");
  }

  const remove = nextValue === null && !nextLocked;
  let saved: Row | undefined;
  if (remove) {
    if (prev)
      await tx
        .delete(entries)
        .where(and(eq(entries.layer, "team"), eq(entries.targetId, input.teamId), eq(entries.key, def.key)));
  } else {
    [saved] = await tx
      .insert(entries)
      .values({
        orgId: sql`hive.ctx_org()`,
        layer: "team",
        targetId: input.teamId,
        key: def.key,
        value: nextValue,
        locked: nextLocked,
        updatedBy: userId,
      })
      .onConflictDoUpdate({
        target: [entries.orgId, entries.layer, entries.targetId, entries.key],
        set: {
          value: nextValue,
          locked: nextLocked,
          version: sql`${entries.version} + 1`,
          updatedBy: userId,
          updatedAt: sql`now()`,
        },
      })
      .returning();
  }
  await recordAudit(tx, {
    action: "config.team.set",
    targetType: "team",
    targetId: input.teamId,
    data: {
      key: def.key,
      before: prev ? { value: prev.value, locked: prev.locked } : null,
      after: remove ? null : { value: nextValue, locked: nextLocked },
    },
  });
  return saved ? view(saved) : null;
}

/** Khoá hoặc mở khoá một cài đặt cho cả công ty (FR-020..023). Giá trị công ty nếu có vẫn giữ nguyên. */
export async function setOrgLock(tx: Tx, userId: string, key: string, locked: boolean): Promise<void> {
  const def = defOf(key);
  if (!def.layers.includes("org"))
    throw new BadRequestError("CONFIG_LAYER_NOT_ALLOWED", "Cài đặt này không đặt được ở cấp công ty.");
  checkLockable(def);
  await allowWith(tx, userId, "policies.write", () => requireOrgRole(tx, userId, "admin"));
  const orgId = await ctxOrg(tx);
  const at = and(eq(entries.layer, "org"), eq(entries.targetId, orgId), eq(entries.key, key));
  const [prev] = await tx.select().from(entries).where(at);
  if (!locked && prev && prev.value === null) {
    await tx.delete(entries).where(at);
  } else if (locked || prev) {
    await tx
      .insert(entries)
      .values({
        orgId: sql`hive.ctx_org()`,
        layer: "org",
        targetId: orgId,
        key,
        value: null,
        locked,
        updatedBy: userId,
      })
      .onConflictDoUpdate({
        target: [entries.orgId, entries.layer, entries.targetId, entries.key],
        set: { locked, version: sql`${entries.version} + 1`, updatedBy: userId, updatedAt: sql`now()` },
      });
  }
  await recordAudit(tx, {
    action: "config.org.lock",
    targetType: "org",
    targetId: orgId,
    data: { key, before: prev?.locked ?? false, after: locked },
  });
}
