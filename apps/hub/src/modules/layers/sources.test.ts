import { DEFAULT_AGENT_POLICY, defaultProjectSettings, type ProjectBudget } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import { clampBudget, machineSlots, type Policy, resolvePermission } from "../governance/index.ts";
import { resolveConfig } from "./engine.ts";
import { buildLayers, type StoredEntry } from "./sources.ts";

const ORG = "00000000-0000-4000-8000-000000000001";
const TEAM = "00000000-0000-4000-8000-000000000002";
const PROJECT = "00000000-0000-4000-8000-000000000003";

const settingsOf = (patch: { perRunUsd?: number; mode?: "workspace" | "full" }) => {
  const s = structuredClone(defaultProjectSettings(1));
  if (patch.perRunUsd !== undefined) s.budget = { ...s.budget, perRunUsd: patch.perRunUsd } as ProjectBudget;
  if (patch.mode) s.runPermissions = { mode: patch.mode };
  return s;
};
const effective = (policy: Policy, s: ReturnType<typeof settingsOf>, entries: StoredEntry[] = []) =>
  new Map(
    resolveConfig(buildLayers({ orgId: ORG, teamId: TEAM, projectId: PROJECT, policy, settings: s, entries })).map(
      (x) => [x.key, x.value],
    ),
  );
type PolicyPatch = Partial<Omit<Policy, "limits">> & { limits?: Partial<Policy["limits"]> };
const withPolicy = (p: PolicyPatch): Policy => ({
  ...DEFAULT_AGENT_POLICY,
  ...p,
  limits: { ...DEFAULT_AGENT_POLICY.limits, ...p.limits },
});

describe("golden: engine khớp các hàm resolve hiện có khi không có tầng đội", () => {
  const caps = [null, 3, 10];
  const budgets = [undefined, 1, 5, 50];
  it("limits.perRunUsd = clampBudget", () => {
    for (const cap of caps)
      for (const b of budgets) {
        const policy = withPolicy({ limits: { perRunUsd: cap } });
        const s = settingsOf(b === undefined ? {} : { perRunUsd: b });
        const old = clampBudget(policy, b === undefined ? undefined : { perRunUsd: b })?.perRunUsd ?? null;
        expect(effective(policy, s).get("limits.perRunUsd")).toBe(old);
      }
  });
  it("agent.permissionMode = resolvePermission", () => {
    for (const allow of [true, false])
      for (const mode of ["workspace", "full"] as const) {
        const policy = withPolicy({ allowFullPermission: allow });
        expect(effective(policy, settingsOf({ mode })).get("agent.permissionMode")).toBe(
          resolvePermission(policy, mode).mode,
        );
      }
  });
  it("limits.maxParallelPerMachine = machineSlots", () => {
    for (const max of [null, 1, 4])
      for (const capacity of [1, 2, 8]) {
        const policy = withPolicy({ limits: { maxParallelPerMachine: max } });
        const v = effective(policy, settingsOf({})).get("limits.maxParallelPerMachine") as number | null;
        expect(v === null ? capacity : Math.min(capacity, v)).toBe(machineSlots(policy, capacity));
      }
  });
});

describe("tầng đội", () => {
  it("đội hạ trần thấp hơn công ty, đội khác không ảnh hưởng", () => {
    const policy = withPolicy({ limits: { perRunUsd: 20 } });
    const entries: StoredEntry[] = [
      { layer: "team", targetId: TEAM, key: "limits.perRunUsd", value: 5, locked: false },
      { layer: "team", targetId: "other-team", key: "limits.perRunUsd", value: 1, locked: false },
    ];
    expect(effective(policy, settingsOf({ perRunUsd: 8 }), entries).get("limits.perRunUsd")).toBe(5);
  });
  it("khoá của công ty trong bảng chặn ghi đè của dự án", () => {
    const entries: StoredEntry[] = [{ layer: "org", targetId: ORG, key: "merge.mode", value: null, locked: true }];
    const s = settingsOf({});
    s.merge.mode = "auto";
    expect(effective(DEFAULT_AGENT_POLICY, s, entries).get("merge.mode")).toBe("review");
  });
});
