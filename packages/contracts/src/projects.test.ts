import { describe, expect, it } from "vitest";
import {
  defaultProjectSettings,
  defaultRouting,
  defaultTokenSaving,
  projectSettings,
  projectSettingsPatch,
} from "./projects.ts";

describe("quyền CLI trong dự án", () => {
  it("chấp nhận settings cũ và hai chế độ quyền", () => {
    const settings = defaultProjectSettings();
    expect(projectSettings.parse(settings).runPermissions).toBeUndefined();
    for (const mode of ["workspace", "full"] as const) {
      expect(projectSettings.parse({ ...settings, runPermissions: { mode } }).runPermissions).toEqual({ mode });
    }
    expect(projectSettings.safeParse({ ...settings, runPermissions: { mode: "unknown" } }).success).toBe(false);
  });
});

describe("tiết kiệm token trong dự án", () => {
  it("settings lưu trước khi có mục này được điền mặc định", () => {
    const { tokenSaving: _, ...old } = defaultProjectSettings();
    expect(projectSettings.parse(old).tokenSaving).toEqual({
      enabled: true,
      bashMaxChars: 15_000,
      autocompactPct: 70,
      subagentModel: "sonnet",
      cacheTtl: "5m",
      autocompactWindow: 200_000,
      allowWeb: false,
    });
    expect(defaultTokenSaving.enabled).toBe(true);
  });

  it("mục tokenSaving lưu trước khi có autocompactWindow/allowWeb vẫn đọc được", () => {
    const { autocompactWindow: _a, allowWeb: _w, ...old } = defaultTokenSaving;
    const parsed = projectSettings.parse({ ...defaultProjectSettings(), tokenSaving: old });
    expect(parsed.tokenSaving).toEqual(defaultTokenSaving);
  });

  it("kiểm khoảng giá trị và thời gian giữ cache", () => {
    const ok = { ...defaultTokenSaving };
    expect(projectSettings.safeParse({ ...defaultProjectSettings(), tokenSaving: ok }).success).toBe(true);
    for (const bad of [
      { bashMaxChars: 999 },
      { bashMaxChars: 150_001 },
      { autocompactPct: 0 },
      { autocompactPct: 101 },
      { autocompactPct: 70.5 },
      { subagentModel: "  " },
      { cacheTtl: "30m" },
      { autocompactWindow: 49_999 },
      { autocompactWindow: 1_000_001 },
      { allowWeb: "yes" },
    ]) {
      expect(projectSettings.safeParse({ ...defaultProjectSettings(), tokenSaving: { ...ok, ...bad } }).success).toBe(
        false,
      );
    }
  });

  it("bản vá nhận từng trường và từ chối khoá lạ", () => {
    expect(projectSettingsPatch.safeParse({ tokenSaving: { cacheTtl: "1h" } }).success).toBe(true);
    expect(projectSettingsPatch.safeParse({ tokenSaving: { enabled: false } }).success).toBe(true);
    expect(projectSettingsPatch.safeParse({ tokenSaving: { cacheTTL: "1h" } }).success).toBe(false);
  });
});

describe("định tuyến model theo cấp độ task", () => {
  it("settings lưu trước khi có mục này được điền mặc định", () => {
    const { routing: _, ...old } = defaultProjectSettings();
    expect(projectSettings.parse(old).routing).toEqual(defaultRouting);
    expect(defaultRouting.tiers.light).toMatchObject({ model: "sonnet", effort: "medium" });
    expect(defaultRouting.tiers.medium).toMatchObject({ model: "sonnet", effort: "high" });
    expect(defaultRouting.tiers.heavy).toMatchObject({ model: "opus", effort: "high" });
  });

  it("kiểm effort, số lượt và tên model", () => {
    const tiers = defaultRouting.tiers;
    const withLight = (light: object) => ({
      ...defaultProjectSettings(),
      routing: { enabled: true, tiers: { ...tiers, light: { ...tiers.light, ...light } } },
    });
    expect(projectSettings.safeParse(withLight({})).success).toBe(true);
    expect(projectSettings.safeParse(withLight({ advisor: "opus" })).success).toBe(true);
    for (const bad of [{ effort: "max" }, { maxTurns: 0 }, { maxTurns: 10_001 }, { model: " " }, { advisor: "" }]) {
      expect(projectSettings.safeParse(withLight(bad)).success).toBe(false);
    }
  });

  it("bản vá nhận từng cấp, cho advisor null, từ chối khoá lạ", () => {
    expect(projectSettingsPatch.safeParse({ routing: { enabled: false } }).success).toBe(true);
    expect(projectSettingsPatch.safeParse({ routing: { tiers: { heavy: { maxTurns: 300 } } } }).success).toBe(true);
    expect(projectSettingsPatch.safeParse({ routing: { tiers: { medium: { advisor: null } } } }).success).toBe(true);
    expect(projectSettingsPatch.safeParse({ routing: { tiers: { medium: { effort: "xhigh" } } } }).success).toBe(false);
    expect(projectSettingsPatch.safeParse({ routing: { tier: {} } }).success).toBe(false);
  });
});
