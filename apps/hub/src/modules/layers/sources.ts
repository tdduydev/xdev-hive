import type { ConfigLayer, ProjectSettings } from "@xdev-hive/contracts";
import type { Policy } from "../governance/index.ts";
import type { LayerInput } from "./engine.ts";

/**
 * Chuyển nơi lưu hiện có sang bản đồ khoá phẳng (FR-001..003): chính sách tổ chức và cài đặt dự án vẫn nằm đúng chỗ
 * cũ, engine chỉ đọc qua các adapter này. Nhờ vậy nâng cấp không cần di chuyển dữ liệu và trang cũ vẫn sửa được.
 */
export function orgValuesFromPolicy(policy: Policy): Record<string, unknown> {
  return {
    "agent.allowFullPermission": policy.allowFullPermission,
    "agent.requireSandbox": policy.requireSandbox,
    "agent.neverAutoUpgrade": policy.neverAutoUpgrade,
    "agent.managedHooksOnly": policy.managedHooksOnly,
    "agent.memoryMode": policy.agentMemory.mode,
    "agent.hooks": policy.hooks,
    "limits.perRunUsd": policy.limits.perRunUsd,
    "limits.dailyUsd": policy.limits.dailyUsd,
    "limits.maxParallelPerMachine": policy.limits.maxParallelPerMachine,
    "limits.runLogRetentionDays": policy.limits.runLogRetentionDays,
  };
}

/** Chỉ đưa khoá dự án đã đặt rõ; khoá vắng là "chưa đặt" để thừa kế từ tầng trên. */
export function projectValuesFromSettings(settings: ProjectSettings): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  if (settings.runPermissions) values["agent.permissionMode"] = settings.runPermissions.mode;
  if (settings.budget?.perRunUsd !== undefined) values["limits.perRunUsd"] = settings.budget.perRunUsd;
  values["merge.mode"] = settings.merge.mode;
  if (settings.merge.requireCi !== undefined) values["merge.requireCi"] = settings.merge.requireCi;
  return values;
}

export type StoredEntry = {
  layer: "org" | "team";
  targetId: string;
  key: string;
  value: unknown;
  locked: boolean;
};

/**
 * Dựng các tầng của một dự án. `teamId` là đội của dự án; hàng của đội khác không được lọt vào (hai dự án khác đội
 * không dùng chung cấu hình). Hàng của đội đã xoá không có trong `teamId` nên tự bị bỏ qua.
 */
export function buildLayers(input: {
  orgId: string;
  teamId: string;
  projectId: string;
  policy: Policy;
  settings: ProjectSettings;
  entries: readonly StoredEntry[];
}): LayerInput[] {
  const fromEntries = (layer: ConfigLayer, targetId: string): { values: Record<string, unknown>; locks: string[] } => {
    const mine = input.entries.filter((e) => e.layer === layer && e.targetId === targetId);
    return {
      values: Object.fromEntries(mine.filter((e) => e.value !== null).map((e) => [e.key, e.value])),
      locks: mine.filter((e) => e.locked).map((e) => e.key),
    };
  };
  const org = fromEntries("org", input.orgId);
  return [
    // Khoá trong bảng thắng giá trị cùng khoá từ chính sách chỉ khi bảng có giá trị; adapter chính sách đặt nền.
    {
      layer: "org",
      targetId: input.orgId,
      values: { ...orgValuesFromPolicy(input.policy), ...org.values },
      locks: org.locks,
    },
    { layer: "team", targetId: input.teamId, ...fromEntries("team", input.teamId) },
    { layer: "project", targetId: input.projectId, values: projectValuesFromSettings(input.settings) },
  ];
}
