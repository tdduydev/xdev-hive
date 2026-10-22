import { describe, expect, it } from "vitest";
import {
  defaultProjectSettings,
  defaultRouting,
  defaultTokenSaving,
  devOptimizerPolicy,
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
      rtk: true,
      codegraph: true,
      contextPack: true,
      exploreBudget: 4,
      toolOutputMaxChars: 12_000,
    });
    expect(defaultTokenSaving.enabled).toBe(true);
  });

  it("tokenSaving đã lưu thiếu rtk và codegraph vẫn hợp lệ và bật", () => {
    const { rtk: _r, codegraph: _c, ...old } = defaultTokenSaving;
    const parsed = projectSettings.parse({ ...defaultProjectSettings(), tokenSaving: old }).tokenSaving;
    expect(parsed.rtk).toBe(true);
    expect(parsed.codegraph).toBe(true);
    const off = projectSettings.parse({
      ...defaultProjectSettings(),
      tokenSaving: { ...old, rtk: false, codegraph: false },
    }).tokenSaving;
    expect(off).toMatchObject({ rtk: false, codegraph: false });
  });

  it("mục tokenSaving lưu trước khi có context pack và hook vẫn đọc được với mặc định bật", () => {
    const { contextPack: _p, exploreBudget: _b, toolOutputMaxChars: _c, ...old } = defaultTokenSaving;
    const parsed = projectSettings.parse({ ...defaultProjectSettings(), tokenSaving: old }).tokenSaving;
    expect(parsed).toMatchObject({ contextPack: true, exploreBudget: 4, toolOutputMaxChars: 12_000 });
  });

  it("exploreBudget và toolOutputMaxChars: 0 là tắt, ngưỡng cắt dưới 2.000 ký tự bị từ chối", () => {
    expect(
      projectSettingsPatch.parse({ tokenSaving: { exploreBudget: 0, toolOutputMaxChars: 0 } }).tokenSaving,
    ).toEqual({
      exploreBudget: 0,
      toolOutputMaxChars: 0,
    });
    for (const bad of [
      { exploreBudget: -1 },
      { exploreBudget: 51 },
      { toolOutputMaxChars: 500 },
      { toolOutputMaxChars: 1.5 },
    ]) {
      expect(projectSettingsPatch.safeParse({ tokenSaving: bad }).success).toBe(false);
    }
  });

  it("bản vá không tự điền mặc định cho trường vắng", () => {
    const parsed = projectSettingsPatch.parse({ tokenSaving: { bashMaxChars: 2000 } });
    expect(parsed.tokenSaving).toEqual({ bashMaxChars: 2000 });
    expect(projectSettingsPatch.parse({ tokenSaving: { rtk: false } }).tokenSaving).toEqual({ rtk: false });
    expect(projectSettingsPatch.safeParse({ tokenSaving: { codegraph: "yes" } }).success).toBe(false);
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

describe("cài đặt kho tài liệu", () => {
  it("settings cũ chưa có docs vẫn parse với đầy đủ mặc định", () => {
    const { docs: _, ...old } = defaultProjectSettings();
    expect(projectSettings.parse(old).docs).toEqual({
      enabled: false,
      root: "docs/",
      repoSync: "pr",
      assetsDir: "assets",
      repoChangesNeedReview: false,
      wordImportConfidential: false,
      include: ["docs/**", "doc/**", "specs/**", "adr/**", "**/adr/**", "**/README.md", "*.md"],
      exclude: [
        "node_modules/**",
        "vendor/**",
        ".git/**",
        ".github/**",
        ".claude/**",
        ".hive/**",
        "**/CHANGELOG.md",
        "**/LICENSE*",
      ],
    });
    expect(projectSettings.parse({ ...old, docs: {} }).docs).toEqual(defaultProjectSettings().docs);
    expect(projectSettings.parse({ ...old, docs: { enabled: true } }).docs.root).toBe("docs/");
  });

  it("mặc định danh sách độc lập giữa các lần parse", () => {
    const a = defaultProjectSettings();
    a.docs.include.push("custom/**");
    expect(defaultProjectSettings().docs.include).not.toContain("custom/**");
  });

  it("bản vá không điền trường vắng, giữ giá trị false và danh sách rỗng", () => {
    expect(projectSettingsPatch.parse({ docs: { enabled: false, include: [] } }).docs).toEqual({
      enabled: false,
      include: [],
    });
    expect(projectSettingsPatch.safeParse({ docs: { assetDir: "assets" } }).success).toBe(false);
    for (const docs of [{ root: "../docs" }, { assetsDir: "/tmp" }, { repoSync: "auto" }, { enabled: "true" }]) {
      expect(projectSettingsPatch.safeParse({ docs }).success).toBe(false);
    }
  });

  it("nhãn mật khi nhập Word mặc định tắt, vá được riêng", () => {
    const { docs, ...rest } = defaultProjectSettings();
    const { wordImportConfidential: _, ...oldDocs } = docs;
    expect(projectSettings.parse({ ...rest, docs: oldDocs }).docs.wordImportConfidential).toBe(false);
    expect(projectSettingsPatch.parse({ docs: { wordImportConfidential: true } }).docs).toEqual({
      wordImportConfidential: true,
    });
    expect(projectSettingsPatch.safeParse({ docs: { wordImportConfidential: "true" } }).success).toBe(false);
  });
});

describe("chính sách tối ưu máy dev", () => {
  const policy = (over: Record<string, unknown> = {}) => ({ ...devOptimizerPolicy.parse({}), ...over });

  it("mặc định cân bằng, tắt rtk, codegraph và đồng bộ memory", () => {
    expect(devOptimizerPolicy.parse({})).toEqual({
      level: "balanced",
      rtk: false,
      codegraph: false,
      autoCompactWindow: null,
      contextBudgetTokens: 2000,
      memoryAutoSync: false,
      memorySyncMinutes: 60,
    });
  });

  it("settings lưu trước khi có mục này là null, không đụng tokenSaving", () => {
    const { devOptimizer: _, ...old } = defaultProjectSettings();
    const parsed = projectSettings.parse(old);
    expect(parsed.devOptimizer).toBeNull();
    expect(parsed.tokenSaving).toEqual(defaultTokenSaving);
    expect(defaultProjectSettings().devOptimizer).toBeNull();
  });

  it("settings giữ chính sách đã đặt", () => {
    const set = policy({ level: "aggressive", rtk: true, autoCompactWindow: 120_000 });
    expect(projectSettings.parse({ ...defaultProjectSettings(), devOptimizer: set }).devOptimizer).toEqual(set);
  });

  it("contextBudgetTokens nhận 500 đến 8.000", () => {
    for (const v of [500, 2000, 8000])
      expect(devOptimizerPolicy.safeParse({ contextBudgetTokens: v }).success).toBe(true);
    for (const v of [499, 8001, 0, -1, 1000.5, "2000"]) {
      expect(devOptimizerPolicy.safeParse({ contextBudgetTokens: v }).success).toBe(false);
    }
  });

  it("memorySyncMinutes nhận 15 đến 1.440", () => {
    for (const v of [15, 60, 1440]) expect(devOptimizerPolicy.safeParse({ memorySyncMinutes: v }).success).toBe(true);
    for (const v of [14, 1441, 0, 30.5, "60"]) {
      expect(devOptimizerPolicy.safeParse({ memorySyncMinutes: v }).success).toBe(false);
    }
  });

  it("autoCompactWindow nhận 50.000 đến 1.000.000 hoặc null", () => {
    for (const v of [50_000, 200_000, 1_000_000, null]) {
      expect(devOptimizerPolicy.safeParse({ autoCompactWindow: v }).success).toBe(true);
    }
    for (const v of [49_999, 1_000_001, 0, 100_000.5, "100000"]) {
      expect(devOptimizerPolicy.safeParse({ autoCompactWindow: v }).success).toBe(false);
    }
  });

  it("level chỉ nhận off, balanced, aggressive", () => {
    for (const v of ["off", "balanced", "aggressive"])
      expect(devOptimizerPolicy.safeParse({ level: v }).success).toBe(true);
    expect(devOptimizerPolicy.safeParse({ level: "max" }).success).toBe(false);
  });

  it("bản vá đặt, thay hoặc bỏ chính sách và từ chối khoá lạ", () => {
    expect(projectSettingsPatch.parse({ devOptimizer: { level: "off" } }).devOptimizer).toEqual(
      policy({ level: "off" }),
    );
    expect(projectSettingsPatch.parse({ devOptimizer: null }).devOptimizer).toBeNull();
    expect(projectSettingsPatch.parse({ tokenSaving: { rtk: false } }).devOptimizer).toBeUndefined();
    expect(projectSettingsPatch.safeParse({ devOptimizer: { levl: "off" } }).success).toBe(false);
    expect(projectSettingsPatch.safeParse({ devOptimizer: { contextBudgetTokens: 9000 } }).success).toBe(false);
  });
});
