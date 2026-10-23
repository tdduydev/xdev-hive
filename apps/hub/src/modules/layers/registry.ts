import { type ConfigLayer, runPermissionMode } from "@xdev-hive/contracts";
import { z } from "zod";

export type SettingDef = {
  key: string;
  group: "agent" | "limits" | "project";
  schema: z.ZodType;
  /** Giữ hành vi hiện có khi tổ chức chưa đặt cấu hình chung. */
  default: unknown;
};

/**
 * Chỉ các cài đặt mà dự án đã tự đặt được (project.settings) và công ty có lý do đặt chung hoặc khoá. Các giới hạn của
 * chính sách chưa ánh xạ (danh sách model, hook, sandbox) vẫn nằm ở chính sách agent và không đi qua đây.
 */
export const REGISTRY: readonly SettingDef[] = [
  { key: "agent.permissionMode", group: "agent", schema: runPermissionMode, default: "workspace" },
  { key: "limits.perRunUsd", group: "limits", schema: z.number().positive().max(100_000).nullable(), default: null },
  { key: "merge.mode", group: "project", schema: z.enum(["review", "auto"]), default: "review" },
  { key: "merge.requireCi", group: "project", schema: z.boolean(), default: false },
];

const byKey = new Map(REGISTRY.map((d) => [d.key, d]));
export const findSetting = (key: string): SettingDef | undefined => byKey.get(key);

export const publicDef = (d: SettingDef) => ({
  key: d.key,
  group: d.group,
  layers: ["org", "project"] as ConfigLayer[],
  default: d.default,
});
