import {
  type ConfigLayer,
  type MergeKind,
  policyHook,
  runLogRetentionDays,
  runPermissionMode,
} from "@xdev-hive/contracts";
import { z } from "zod";

/** Thứ tự từ ngoài vào trong: tầng đứng sau là tầng cụ thể hơn. */
export const LAYER_ORDER: readonly ConfigLayer[] = ["instance", "org", "team", "project"];
export const layerIndex = (l: ConfigLayer) => LAYER_ORDER.indexOf(l);

/**
 * Cách so độ chặt của một trần. `rank` càng nhỏ càng chặt; engine lấy giá trị có rank nhỏ nhất. Tách khỏi kiểu giá trị
 * để thêm cài đặt mới chỉ cần chọn một cách so, không viết lại thuật toán gộp.
 */
export type CeilingRule = "restrictive-true" | "restrictive-false" | "min-number" | { scale: readonly string[] };

type Base = {
  key: string;
  group: "agent" | "limits" | "project";
  layers: readonly ConfigLayer[];
  /** Nới cài đặt này cần `policies.fullaccess` (FR-043). */
  dangerous: boolean;
  schema: z.ZodType;
  /** Bằng mặc định trong code hiện nay, để tổ chức chưa đặt gì không đổi hành vi (FR-070). */
  default: unknown;
  /** Giá trị client dùng khi ảnh chụp quá cũ; chỉ có ở cài đặt làm rộng quyền (FR-063). */
  safe?: unknown;
};
export type CeilingDef = Base & { kind: "ceiling"; rule: CeilingRule };
export type OverrideDef = Base & {
  kind: "override";
  /** Thu hẹp giá trị sau khi mọi cài đặt đã gộp, ví dụ `full` về `workspace` khi tổ chức cấm toàn quyền. */
  narrow?: (value: unknown, resolved: ReadonlyMap<string, unknown>) => unknown;
};
export type AdditiveDef = Base & { kind: "additive"; identity: (item: unknown) => string };
export type SettingDef = CeilingDef | OverrideDef | AdditiveDef;

const nullablePositive = (max: number) => z.number().positive().max(max).nullable();
const memoryMode = ["off", "propose", "direct"] as const;

export const REGISTRY: readonly SettingDef[] = [
  {
    key: "agent.allowFullPermission",
    group: "agent",
    kind: "ceiling",
    rule: "restrictive-false",
    layers: ["instance", "org", "team"],
    dangerous: true,
    schema: z.boolean(),
    default: true,
    safe: false,
  },
  {
    key: "agent.requireSandbox",
    group: "agent",
    kind: "ceiling",
    rule: "restrictive-true",
    layers: ["instance", "org", "team"],
    dangerous: false,
    schema: z.boolean(),
    default: false,
  },
  {
    key: "agent.neverAutoUpgrade",
    group: "agent",
    kind: "ceiling",
    rule: "restrictive-true",
    layers: ["instance", "org", "team"],
    dangerous: false,
    schema: z.boolean(),
    default: false,
  },
  {
    key: "agent.managedHooksOnly",
    group: "agent",
    kind: "ceiling",
    rule: "restrictive-true",
    layers: ["instance", "org", "team"],
    dangerous: false,
    schema: z.boolean(),
    default: false,
    safe: true,
  },
  {
    key: "agent.memoryMode",
    group: "agent",
    kind: "ceiling",
    rule: { scale: memoryMode },
    layers: ["instance", "org", "team"],
    dangerous: false,
    schema: z.enum(memoryMode),
    default: "propose",
    safe: "off",
  },
  {
    key: "agent.permissionMode",
    group: "agent",
    kind: "override",
    layers: ["org", "project"],
    dangerous: false,
    schema: runPermissionMode,
    default: "workspace",
    safe: "workspace",
    // Tầng nào đặt `full` cũng không vượt được quyền toàn quyền của tổ chức.
    narrow: (value, resolved) =>
      value === "full" && resolved.get("agent.allowFullPermission") === false ? "workspace" : value,
  },
  {
    key: "agent.hooks",
    group: "agent",
    kind: "additive",
    layers: ["instance", "org", "team"],
    dangerous: false,
    schema: z.array(policyHook).max(30),
    default: [],
    identity: (h) => {
      const hook = h as z.output<typeof policyHook>;
      return `${hook.event}\u0000${hook.name}`;
    },
  },
  {
    key: "limits.perRunUsd",
    group: "limits",
    kind: "ceiling",
    rule: "min-number",
    layers: ["instance", "org", "team", "project"],
    dangerous: false,
    schema: nullablePositive(100_000),
    default: null,
  },
  {
    key: "limits.dailyUsd",
    group: "limits",
    kind: "ceiling",
    rule: "min-number",
    layers: ["instance", "org", "team"],
    dangerous: false,
    schema: nullablePositive(10_000_000),
    default: null,
  },
  {
    key: "limits.maxParallelPerMachine",
    group: "limits",
    kind: "ceiling",
    rule: "min-number",
    layers: ["instance", "org", "team"],
    dangerous: false,
    schema: z.number().int().min(1).max(64).nullable(),
    default: null,
  },
  {
    key: "limits.runLogRetentionDays",
    group: "limits",
    kind: "ceiling",
    rule: "min-number",
    layers: ["instance", "org", "team"],
    dangerous: false,
    schema: runLogRetentionDays,
    default: 365,
  },
  {
    key: "merge.mode",
    group: "project",
    kind: "override",
    layers: ["org", "team", "project"],
    dangerous: false,
    schema: z.enum(["review", "auto"]),
    default: "review",
    safe: "review",
  },
  {
    key: "merge.requireCi",
    group: "project",
    kind: "override",
    layers: ["org", "team", "project"],
    dangerous: false,
    schema: z.boolean(),
    default: false,
    safe: true,
  },
];

const byKey = new Map(REGISTRY.map((d) => [d.key, d]));
export const findSetting = (key: string): SettingDef | undefined => byKey.get(key);

export function publicDef(d: SettingDef): {
  key: string;
  group: Base["group"];
  kind: MergeKind;
  layers: ConfigLayer[];
  dangerous: boolean;
} {
  return { key: d.key, group: d.group, kind: d.kind, layers: [...d.layers], dangerous: d.dangerous };
}
