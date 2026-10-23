import { DEFAULT_AGENT_POLICY, defaultProjectSettings } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import { applySettingsPatch } from "../catalog/index.ts";
import { resolveConfig } from "./engine.ts";
import { buildLayers, projectValuesFromSettings } from "./sources.ts";

describe("nguồn cấu hình", () => {
  const settings = defaultProjectSettings(1);
  it("preserves inheritance for unrelated legacy writes and clears it for a changed value", () => {
    const current = { ...settings, inheritedConfigKeys: ["merge.mode" as const] };
    expect(applySettingsPatch(current, { merge: { mode: "review", requireCi: true } }).inheritedConfigKeys).toEqual([
      "merge.mode",
    ]);
    expect(applySettingsPatch(current, { merge: { mode: "auto" } }).inheritedConfigKeys).toEqual([]);
  });
  it("keeps legacy project values explicit until inheritance is requested", () => {
    expect(projectValuesFromSettings(settings)).toEqual({ "merge.mode": "review" });
    expect(projectValuesFromSettings({ ...settings, inheritedConfigKeys: ["merge.mode"] })).toEqual({});
  });
  it("uses policy defaults and isolates entries by organization", () => {
    const result = resolveConfig(
      buildLayers({
        orgId: "a",
        projectId: "p",
        policy: { ...DEFAULT_AGENT_POLICY, defaultPermissionMode: "full" },
        settings,
        entries: [
          { layer: "org", targetId: "b", key: "merge.mode", value: "auto", locked: true },
          { layer: "project", targetId: "p", key: "merge.mode", value: "auto", locked: false },
        ],
      }),
    );
    expect(result.find((s) => s.key === "agent.permissionMode")).toMatchObject({
      value: "full",
      source: { layer: "org" },
    });
    expect(result.find((s) => s.key === "merge.mode")).toMatchObject({ value: "review", locked: false });
  });
  it("does not let a stale table value shadow a policy edit", () => {
    const result = buildLayers({
      orgId: "a",
      projectId: "p",
      policy: DEFAULT_AGENT_POLICY,
      settings,
      entries: [{ layer: "org", targetId: "a", key: "agent.permissionMode", value: "full", locked: true }],
    });
    expect(result[0]?.values["agent.permissionMode"]).toBe("workspace");
    expect(result[0]?.locks).toEqual(["agent.permissionMode"]);
  });
});
