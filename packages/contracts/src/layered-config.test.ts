import { describe, expect, it } from "vitest";
import { configLayer, effectiveSetting, orgSetInput } from "./layered-config.ts";
import { defaultProjectSettings, projectSettings, projectSettingsPatch } from "./projects.ts";

describe("cấu hình hai lớp", () => {
  it("accepts only organization and project layers", () => {
    for (const layer of ["org", "project"]) expect(configLayer.safeParse(layer).success).toBe(true);
    for (const layer of ["instance", "team", "run"]) expect(configLayer.safeParse(layer).success).toBe(false);
  });
  it("supports changing only a lock and removing an organization value", () => {
    expect(orgSetInput.parse({ key: "merge.mode", locked: true })).toEqual({ key: "merge.mode", locked: true });
    expect(orgSetInput.parse({ key: "merge.mode", value: null }).value).toBeNull();
  });
  it("returns a source and a lock without ceiling metadata", () => {
    expect(
      effectiveSetting.parse({ key: "merge.mode", value: "review", source: null, locked: false, chain: [] }),
    ).toEqual({ key: "merge.mode", value: "review", source: null, locked: false, chain: [] });
  });
  it("accepts legacy settings and restricts explicit inheritance to known keys", () => {
    expect(projectSettings.safeParse(defaultProjectSettings()).success).toBe(true);
    expect(projectSettingsPatch.safeParse({ inheritedConfigKeys: ["merge.mode"] }).success).toBe(true);
    expect(projectSettingsPatch.safeParse({ inheritedConfigKeys: ["unknown"] }).success).toBe(false);
  });
});
