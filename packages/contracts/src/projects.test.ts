import { describe, expect, it } from "vitest";
import { defaultProjectSettings, defaultTokenSaving, projectSettings, projectSettingsPatch } from "./projects.ts";

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
    });
    expect(defaultTokenSaving.enabled).toBe(true);
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
