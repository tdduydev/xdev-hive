import type { ProjectSettings } from "@xdev-hive/contracts";
import type { Policy } from "../governance/index.ts";
import type { LayerInput } from "./engine.ts";

export function orgValuesFromPolicy(policy: Policy): Record<string, unknown> {
  return { "agent.permissionMode": policy.defaultPermissionMode, "limits.perRunUsd": policy.limits.perRunUsd };
}

export function projectValuesFromSettings(settings: ProjectSettings): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  if (settings.runPermissions) values["agent.permissionMode"] = settings.runPermissions.mode;
  if (settings.budget?.perRunUsd !== undefined) values["limits.perRunUsd"] = settings.budget.perRunUsd;
  if (settings.merge?.mode !== undefined) values["merge.mode"] = settings.merge.mode;
  if (settings.merge?.requireCi !== undefined) values["merge.requireCi"] = settings.merge.requireCi;
  for (const key of settings.inheritedConfigKeys ?? []) delete values[key];
  return values;
}

export type StoredEntry = { layer: "org" | "project"; targetId: string; key: string; value: unknown; locked: boolean };

export function buildLayers(input: {
  orgId: string;
  projectId: string;
  policy: Policy;
  settings: ProjectSettings;
  entries: readonly StoredEntry[];
}): LayerInput[] {
  const org = input.entries.filter((e) => e.layer === "org" && e.targetId === input.orgId);
  // Các khoá ánh xạ chính sách chỉ có một nguồn giá trị, tránh trang chính sách cũ ghi xong mà không có hiệu lực.
  return [
    {
      layer: "org",
      targetId: input.orgId,
      values: {
        ...Object.fromEntries(org.filter((e) => e.value !== null).map((e) => [e.key, e.value])),
        ...orgValuesFromPolicy(input.policy),
      },
      locks: org.filter((e) => e.locked).map((e) => e.key),
    },
    { layer: "project", targetId: input.projectId, values: projectValuesFromSettings(input.settings) },
  ];
}
