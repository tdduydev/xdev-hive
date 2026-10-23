import { z } from "zod";
import { id, orgRoute } from "./common.ts";

/**
 * Cấu hình theo tầng (specs/033): hệ thống → công ty → đội → dự án. Hub gộp các tầng và chỉ trả giá trị hiệu lực;
 * client không tự gộp (FR-066). Mọi lời gọi thuộc đúng một công ty (header `x-hive-org`), client giữ bộ đệm theo từng
 * công ty (FR-069).
 */
export const CONFIG_LAYERS = ["instance", "org", "team", "project"] as const;
export const configLayer = z.enum(CONFIG_LAYERS);
export type ConfigLayer = z.output<typeof configLayer>;

export const mergeKind = z.enum(["ceiling", "override", "additive"]);
export type MergeKind = z.output<typeof mergeKind>;

export const configGroup = z.enum(["agent", "limits", "project"]);

export const settingKey = z.string().trim().min(1).max(80);

/** Số phiên bản của dạng ảnh chụp; client bỏ qua khoá nó không biết (FR-067). */
export const CONFIG_SCHEMA_VERSION = 1;

export const settingDef = z.object({
  key: settingKey,
  group: configGroup,
  kind: mergeKind,
  layers: z.array(configLayer),
  /** Nới giá trị này ở tầng hệ thống hoặc công ty cần quyền nguy hiểm (FR-043). */
  dangerous: z.boolean(),
});
export type SettingDef = z.output<typeof settingDef>;

const layerRef = z.object({ layer: configLayer, targetId: id.nullable() });

export const effectiveSetting = z.object({
  key: settingKey,
  value: z.unknown(),
  /** Tầng quyết định giá trị; null là giá trị mặc định của sổ cài đặt. */
  source: layerRef.nullable(),
  /** Tầng đã khoá cài đặt này với các tầng dưới nó (FR-021). */
  lock: z.object({ layer: configLayer }).nullable(),
  /** Tầng dưới đã đặt giá trị rộng hơn trần, đang bị hạ (FR-015). */
  overCeiling: layerRef.extend({ value: z.unknown() }).nullable(),
  /** Giá trị từng tầng; chỉ trả cho người có quyền sửa cấu hình dự án (FR-044). */
  chain: z.array(layerRef.extend({ value: z.unknown(), locked: z.boolean(), applied: z.boolean() })).optional(),
});
export type EffectiveSetting = z.output<typeof effectiveSetting>;

export const effectiveConfig = z.object({
  orgId: id,
  projectId: id,
  schemaVersion: z.number().int(),
  generatedAt: z.iso.datetime(),
  /** Băm nội dung hiệu lực; client chỉ tải lại khi khác (FR-061). */
  configVersion: z.string(),
  settings: z.array(effectiveSetting),
});
export type EffectiveConfig = z.output<typeof effectiveConfig>;

export const layerEntry = z.object({
  layer: z.enum(["org", "team"]),
  targetId: id,
  key: settingKey,
  value: z.unknown().nullable(),
  locked: z.boolean(),
  version: z.number().int(),
  updatedBy: z.string().nullable(),
  updatedAt: z.iso.datetime(),
});
export type LayerEntry = z.output<typeof layerEntry>;

export const teamSetInput = z.object({
  teamId: id,
  key: settingKey,
  /** null là gỡ giá trị của đội (dùng giá trị thừa kế, FR-013); vắng mặt là giữ giá trị cũ, chỉ đổi cờ khoá. */
  value: z.unknown(),
  locked: z.boolean().optional(),
  /** Phiên bản đã đọc; lệch thì báo xung đột thay vì ghi đè (edge case sửa cùng lúc). */
  expectedVersion: z.number().int().min(0).optional(),
});

export const layeredConfigContract = {
  registry: orgRoute("GET", "/v1/config/registry", "Danh sách cài đặt theo tầng", "config").output(
    z.object({ settings: z.array(settingDef) }),
  ),
  effective: orgRoute("GET", "/v1/config/effective", "Cấu hình hiệu lực của dự án", "config")
    .input(z.object({ projectId: id }))
    .output(effectiveConfig),
  teamGet: orgRoute("GET", "/v1/config/team", "Cấu hình riêng của đội", "config")
    .input(z.object({ teamId: id }))
    .output(z.object({ entries: z.array(layerEntry) })),
  teamSet: orgRoute("POST", "/v1/config/team", "Đặt hoặc gỡ cấu hình của đội", "config")
    .input(teamSetInput)
    .output(layerEntry.nullable()),
  orgLock: orgRoute("POST", "/v1/config/org-lock", "Khoá hoặc mở khoá một cài đặt cho cả công ty", "config")
    .input(z.object({ key: settingKey, locked: z.boolean() }))
    .output(z.object({ key: settingKey, locked: z.boolean() })),
};
