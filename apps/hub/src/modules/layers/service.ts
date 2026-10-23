import {
  CONFIG_SCHEMA_VERSION,
  type EffectiveConfig,
  type OrgEntry,
  type orgSetInput,
  type ProjectBudget,
  type ProjectSettings,
} from "@xdev-hive/contracts";
import { and, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import { recordAudit } from "../audit/index.ts";
import { loadProject, updateProjectSettings } from "../catalog/index.ts";
import { loadPolicy, type Policy, saveAgentPolicy } from "../governance/index.ts";
import { BadRequestError, ConflictError, NotFoundError, type Tx } from "../platform/index.ts";
import { allowWith, requireOrgRole, teamRoleOf } from "../tenancy/index.ts";
import { configVersion, resolveConfig } from "./engine.ts";
import { findSetting, REGISTRY } from "./registry.ts";
import { configLayerEntries as entries } from "./schema.ts";
import { buildLayers, orgValuesFromPolicy, projectValuesFromSettings } from "./sources.ts";

async function ctxOrg(tx: Tx): Promise<string> {
  const { rows } = await tx.execute<{ org: string }>(sql`select hive.ctx_org()::text as org`);
  const org = rows[0]?.org;
  if (!org) throw new Error("Thiếu tổ chức trong context.");
  return org;
}

// Mọi đường ghi dùng cùng khoá transaction để thao tác khoá và sửa dự án không vượt qua nhau.
async function lockWrites(tx: Tx) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(hive.ctx_org()::text, 33))`);
}

type ProjectLike = { id: string; teamId: string; settings: ProjectSettings };

async function resolveFor(tx: Tx, project: ProjectLike) {
  const orgId = await ctxOrg(tx);
  const [policy, rows] = await Promise.all([loadPolicy(tx), tx.select().from(entries)]);
  return {
    orgId,
    resolved: resolveConfig(
      buildLayers({ orgId, projectId: project.id, policy, settings: project.settings, entries: rows }),
    ),
  };
}

export async function resolveProjectSettings(tx: Tx, project: ProjectLike): Promise<ProjectSettings> {
  const { resolved } = await resolveFor(tx, project);
  const value = (key: string) => resolved.find((r) => r.key === key)?.value;
  return {
    ...project.settings,
    merge: {
      ...project.settings.merge,
      mode: value("merge.mode") as "review" | "auto",
      requireCi: value("merge.requireCi") as boolean,
    },
  };
}

export async function runSettingsOf(tx: Tx, project: ProjectLike) {
  const { resolved } = await resolveFor(tx, project);
  const value = (key: string) => resolved.find((r) => r.key === key)?.value;
  const mode = value("agent.permissionMode") === "full" ? "full" : "workspace";
  return {
    permission: { mode, notice: null } as { mode: "workspace" | "full"; notice: string | null },
    resolveBudget(budget: ProjectBudget | undefined): ProjectBudget | undefined {
      const cap = value("limits.perRunUsd");
      if (typeof cap === "number") return { ...budget, perRunUsd: cap };
      if (!budget) return undefined;
      const { perRunUsd: _perRunUsd, ...rest } = budget;
      return Object.keys(rest).length ? rest : undefined;
    },
  };
}

export async function assertSettingsUnlocked(
  tx: Tx,
  ctx: { teamId: string; current: ProjectSettings; next: ProjectSettings },
): Promise<void> {
  await lockWrites(tx);
  const orgId = await ctxOrg(tx);
  const rows = await tx
    .select()
    .from(entries)
    .where(and(eq(entries.layer, "org"), eq(entries.targetId, orgId), eq(entries.locked, true)));
  const before = projectValuesFromSettings({ ...ctx.current, inheritedConfigKeys: [] });
  const after = projectValuesFromSettings({ ...ctx.next, inheritedConfigKeys: [] });
  for (const row of rows) {
    const inherits = (settings: ProjectSettings) =>
      settings.inheritedConfigKeys?.some((key) => key === row.key) ?? false;
    if (
      JSON.stringify(before[row.key]) !== JSON.stringify(after[row.key]) ||
      inherits(ctx.current) !== inherits(ctx.next)
    )
      throw new ConflictError("CONFIG_LOCKED", `Cài đặt “${row.key}” đã bị tổ chức khoá, dự án không đổi được.`);
  }
}

/** Chính sách là nguồn duy nhất của các khoá ánh xạ; đổi từ trang cũ vẫn làm mất hiệu lực phiên bản đã đọc. */
export async function syncPolicyEntries(tx: Tx, userId: string, before: Policy, next: Policy): Promise<void> {
  await lockWrites(tx);
  const orgId = await ctxOrg(tx);
  const from = orgValuesFromPolicy(before);
  const to = orgValuesFromPolicy(next);
  for (const key of Object.keys(to)) {
    if (JSON.stringify(from[key]) === JSON.stringify(to[key])) continue;
    await tx
      .insert(entries)
      .values({ layer: "org", targetId: orgId, key, value: null, updatedBy: userId })
      .onConflictDoUpdate({
        target: [entries.orgId, entries.layer, entries.targetId, entries.key],
        set: { value: null, version: sql`${entries.version} + 1`, updatedBy: userId, updatedAt: sql`now()` },
      });
  }
}

export async function effectiveConfig(tx: Tx, userId: string, projectId: string): Promise<EffectiveConfig> {
  const project = await loadProject(tx, projectId);
  if (!project || !(await teamRoleOf(tx, userId, project.teamId)))
    throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án.");
  const { orgId, resolved } = await resolveFor(tx, project);
  return {
    orgId,
    projectId,
    schemaVersion: CONFIG_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    configVersion: configVersion(orgId, resolved),
    settings: resolved,
  };
}

export async function orgEntries(tx: Tx): Promise<OrgEntry[]> {
  const orgId = await ctxOrg(tx);
  const [rows, policy] = await Promise.all([
    tx
      .select()
      .from(entries)
      .where(and(eq(entries.layer, "org"), eq(entries.targetId, orgId))),
    loadPolicy(tx),
  ]);
  const mapped = orgValuesFromPolicy(policy);
  return REGISTRY.map((def) => {
    const row = rows.find((r) => r.key === def.key);
    return {
      key: def.key,
      value: Object.hasOwn(mapped, def.key) ? mapped[def.key] : (row?.value ?? null),
      locked: row?.locked ?? false,
      version: row?.version ?? 0,
      updatedBy: row?.updatedBy ?? null,
      updatedAt: row?.updatedAt.toISOString() ?? new Date(0).toISOString(),
    };
  });
}

export async function setOrgEntry(
  tx: Tx,
  userId: string,
  input: z.output<typeof orgSetInput>,
): Promise<OrgEntry | null> {
  await allowWith(tx, userId, "policies.write", () => requireOrgRole(tx, userId, "admin"));
  const def = findSetting(input.key);
  if (!def) throw new BadRequestError("CONFIG_UNKNOWN_KEY", `Không có cài đặt “${input.key}”.`);
  await lockWrites(tx);
  const orgId = await ctxOrg(tx);
  const before = (await orgEntries(tx)).find((r) => r.key === input.key);
  if (input.expectedVersion !== undefined && input.expectedVersion !== before?.version)
    throw new ConflictError("CONFIG_VERSION_CONFLICT", "Cấu hình vừa được người khác sửa. Hãy tải lại rồi thử lại.");
  const value = input.value === undefined ? (before?.value ?? null) : input.value;
  if (value !== null && !def.schema.safeParse(value).success)
    throw new BadRequestError("CONFIG_VALUE_INVALID", `Giá trị của “${def.key}” không hợp lệ.`);
  const locked = input.locked ?? before?.locked ?? false;
  const mapped = def.key === "agent.permissionMode" || def.key === "limits.perRunUsd";
  if (mapped && input.value !== undefined) {
    const policy = await loadPolicy(tx);
    const next =
      def.key === "agent.permissionMode"
        ? { ...policy, defaultPermissionMode: value ?? def.default }
        : { ...policy, limits: { ...policy.limits, perRunUsd: value } };
    await saveAgentPolicy(tx, userId, next as Policy, syncPolicyEntries);
  }
  // Giữ hàng đã gỡ để số phiên bản không quay lại 0, tránh ghi đè từ một form cũ.
  await tx
    .insert(entries)
    .values({ layer: "org", targetId: orgId, key: def.key, value: mapped ? null : value, locked, updatedBy: userId })
    .onConflictDoUpdate({
      target: [entries.orgId, entries.layer, entries.targetId, entries.key],
      set: {
        value: mapped ? null : value,
        locked,
        version: sql`${entries.version} + 1`,
        updatedBy: userId,
        updatedAt: sql`now()`,
      },
    });
  const after = (await orgEntries(tx)).find((r) => r.key === def.key) ?? null;
  await recordAudit(tx, {
    action: "config.org.set",
    targetType: "org",
    targetId: orgId,
    data: { key: def.key, before, after },
  });
  return after;
}

export async function setProjectEntry(
  tx: Tx,
  userId: string,
  input: { projectId: string; key: string; value: unknown },
): Promise<EffectiveConfig> {
  const def = findSetting(input.key);
  if (!def) throw new BadRequestError("CONFIG_UNKNOWN_KEY", `Không có cài đặt “${input.key}”.`);
  if (input.value !== null && !def.schema.safeParse(input.value).success)
    throw new BadRequestError("CONFIG_VALUE_INVALID", `Giá trị của “${def.key}” không hợp lệ.`);
  const project = await loadProject(tx, input.projectId);
  if (!project || !(await teamRoleOf(tx, userId, project.teamId)))
    throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án.");
  // Khoá dòng trước khi dựng bản vá để hai lần sửa các khoá khác nhau không ghi đè danh sách kế thừa.
  await tx.execute(sql`select id from hive.projects where id = ${project.id}::uuid for update`);
  const latest = await loadProject(tx, project.id);
  if (!latest) throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án.");
  const inherited = new Set(latest.settings.inheritedConfigKeys ?? []);
  const key = input.key as NonNullable<ProjectSettings["inheritedConfigKeys"]>[number];
  if (input.value === null) inherited.add(key);
  else inherited.delete(key);
  const patch =
    input.value === null
      ? {}
      : key === "agent.permissionMode"
        ? { runPermissions: { mode: input.value as "workspace" | "full" } }
        : key === "limits.perRunUsd"
          ? { budget: { perRunUsd: input.value as number } }
          : key === "merge.mode"
            ? { merge: { mode: input.value as "review" | "auto" } }
            : { merge: { requireCi: input.value as boolean } };
  await updateProjectSettings(
    tx,
    userId,
    latest.key,
    { ...patch, inheritedConfigKeys: [...inherited] },
    assertSettingsUnlocked,
  );
  return effectiveConfig(tx, userId, project.id);
}
