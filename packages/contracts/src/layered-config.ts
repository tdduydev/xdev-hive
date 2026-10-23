import { z } from "zod";
import { id, orgRoute } from "./common.ts";

/**
 * Cấu hình hai tầng (specs/033): công ty dùng chung, dự án riêng. Dự án ghi đè giá trị của công ty trừ khi công ty đã
 * khoá mục đó. Hub trả cả giá trị hiệu lực và nguồn; client không tự gộp. Mọi lời gọi thuộc đúng một công
 * ty (header `x-hive-org`).
 */
export const CONFIG_LAYERS = ["org", "project"] as const;
export const configLayer = z.enum(CONFIG_LAYERS);
export type ConfigLayer = z.output<typeof configLayer>;

export const settingKey = z.string().trim().min(1).max(80);

/** Client bỏ qua khoá chưa biết để có thể nâng cấp hub và client riêng. */
export const CONFIG_SCHEMA_VERSION = 1;

export const settingDef = z.object({
  key: settingKey,
  group: z.enum(["agent", "limits", "project"]),
  layers: z.array(configLayer),
  /** Giá trị khi không tầng nào đặt. */
  default: z.unknown(),
});
export type SettingDef = z.output<typeof settingDef>;

const layerRef = z.object({ layer: configLayer, targetId: id.nullable() });

export const effectiveSetting = z.object({
  key: settingKey,
  value: z.unknown(),
  /** Tầng quyết định giá trị; null là giá trị mặc định của sổ cài đặt. */
  source: layerRef.nullable(),
  /** Khi tổ chức khoá, giá trị riêng của dự án tạm ngưng cho tới lúc mở khoá. */
  locked: z.boolean(),
  /** Giá trị từng tầng, và tầng nào đang có hiệu lực. */
  chain: z.array(layerRef.extend({ value: z.unknown(), locked: z.boolean(), applied: z.boolean() })),
});
export type EffectiveSetting = z.output<typeof effectiveSetting>;

export const effectiveConfig = z.object({
  orgId: id,
  projectId: id,
  schemaVersion: z.number().int(),
  generatedAt: z.iso.datetime(),
  /** Băm nội dung hiệu lực và nguồn để nhận biết thay đổi. */
  configVersion: z.string(),
  settings: z.array(effectiveSetting),
});
export type EffectiveConfig = z.output<typeof effectiveConfig>;

export const orgEntry = z.object({
  key: settingKey,
  /** null là "chỉ khoá, chưa đặt giá trị". */
  value: z.unknown().nullable(),
  locked: z.boolean(),
  version: z.number().int(),
  updatedBy: z.string().nullable(),
  updatedAt: z.iso.datetime(),
});
export type OrgEntry = z.output<typeof orgEntry>;

export const orgSetInput = z.object({
  key: settingKey,
  /** null là gỡ giá trị của công ty; vắng mặt là giữ giá trị cũ, chỉ đổi cờ khoá. */
  value: z.unknown().optional(),
  locked: z.boolean().optional(),
  /** Phiên bản đã đọc; lệch thì báo xung đột thay vì ghi đè (sửa cùng lúc). */
  expectedVersion: z.number().int().min(0).optional(),
});

export const layeredConfigContract = {
  registry: orgRoute("GET", "/v1/config/registry", "Danh sách cài đặt theo tầng", "config").output(
    z.object({ settings: z.array(settingDef) }),
  ),
  effective: orgRoute("GET", "/v1/config/effective", "Cấu hình hiệu lực của dự án", "config")
    .input(z.object({ projectId: id }))
    .output(effectiveConfig),
  orgGet: orgRoute("GET", "/v1/config/org", "Cấu hình của công ty", "config").output(
    z.object({ entries: z.array(orgEntry) }),
  ),
  orgSet: orgRoute("POST", "/v1/config/org", "Đặt, khoá hoặc gỡ cấu hình của công ty", "config")
    .input(orgSetInput)
    .output(orgEntry.nullable()),
  projectSet: orgRoute("POST", "/v1/config/project", "Ghi đè hoặc kế thừa cấu hình dự án", "config")
    .input(z.object({ projectId: id, key: settingKey, value: z.unknown() }))
    .output(effectiveConfig),
};
