import { defaultRouting, type PlanContent } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import { pickTier, raiseTier, routeRun, type TierInput } from "./routing.ts";

const base: TierInput = {
  manual: null,
  type: null,
  labels: [],
  title: "Sửa lỗi",
  body: "",
  plan: null,
  retried: false,
};

const plan = (files: string[], steps = 2, risks: string[] = []): PlanContent => ({
  summary: "x",
  steps: Array.from({ length: steps }, (_, i) => ({ title: `Bước ${i + 1}` })),
  files: files.map((path) => ({ path })),
  risks,
  questions: [],
});

describe("pickTier", () => {
  it("không có tín hiệu thì cấp vừa", () => {
    expect(pickTier(base)).toMatchObject({ tier: "medium", baseTier: "medium", source: "default" });
  });

  it("người đặt tay thắng nhãn và kế hoạch", () => {
    const r = pickTier({
      ...base,
      manual: "light",
      labels: ["tier:heavy"],
      plan: plan(["a/b/1", "a/c/2", "d/e/3"], 9),
    });
    expect(r).toMatchObject({ tier: "light", source: "manual" });
  });

  it("nhãn tier:* đặt cấp, không phân biệt hoa thường", () => {
    expect(pickTier({ ...base, labels: ["bug", "Tier:Heavy"] })).toMatchObject({ tier: "heavy", source: "label" });
    expect(pickTier({ ...base, labels: ["tier:bậy"] })).toMatchObject({ tier: "medium", source: "default" });
  });

  it("cỡ kế hoạch: nhỏ, vừa, lớn", () => {
    expect(pickTier({ ...base, plan: plan(["apps/hub/a.ts"], 2) })).toMatchObject({ tier: "light", source: "plan" });
    expect(pickTier({ ...base, plan: plan(["apps/hub/a.ts", "apps/hub/b.ts", "apps/web/c.ts"], 4) })).toMatchObject({
      tier: "medium",
    });
    // Kế hoạch nhỏ nhưng có rủi ro không phải việc nhẹ.
    expect(pickTier({ ...base, plan: plan(["apps/hub/a.ts"], 2, ["đổi schema"]) }).tier).toBe("medium");
    const files = ["apps/hub/a.ts", "apps/web/b.ts", "worker/c.go"];
    expect(pickTier({ ...base, plan: plan(files, 3) })).toMatchObject({ tier: "heavy" });
    expect(pickTier({ ...base, plan: plan(["apps/hub/a.ts"], 8) }).tier).toBe("heavy");
  });

  it("loại task và nhãn: nặng thắng nhẹ", () => {
    expect(pickTier({ ...base, type: "docs" })).toMatchObject({ tier: "light", source: "type" });
    expect(pickTier({ ...base, labels: ["Good First Issue"] }).tier).toBe("light");
    expect(pickTier({ ...base, type: "docs", labels: ["security"] }).tier).toBe("heavy");
  });

  it("mô tả rất dài là nặng, ngắn thì không kết luận gì", () => {
    expect(pickTier({ ...base, body: "x".repeat(4000) })).toMatchObject({ tier: "heavy", source: "description" });
    expect(pickTier({ ...base, body: "x".repeat(100) }).tier).toBe("medium");
  });

  it("kế hoạch thắng loại task", () => {
    expect(pickTier({ ...base, type: "docs", plan: plan(["a/1", "b/2", "c/3"], 2) })).toMatchObject({
      tier: "heavy",
      source: "plan",
    });
  });

  it("thử lại sau lỗi nâng một cấp, dừng ở nặng, và nói rõ lý do", () => {
    const light = pickTier({ ...base, type: "docs", retried: true });
    expect(light).toMatchObject({ tier: "medium", baseTier: "light" });
    expect(light.reasons.at(-1)).toContain("nâng từ cấp nhẹ lên vừa");
    const heavy = pickTier({ ...base, labels: ["tier:heavy"], retried: true });
    expect(heavy).toMatchObject({ tier: "heavy", baseTier: "heavy" });
    expect(heavy.reasons.at(-1)).toContain("cấp cao nhất");
  });

  it("raiseTier", () => {
    expect(["light", "medium", "heavy"].map((t) => raiseTier(t as "light"))).toEqual(["medium", "heavy", "heavy"]);
  });
});

describe("routeRun", () => {
  it("claude: model, effort, số lượt theo cấp", () => {
    expect(routeRun("claude", defaultRouting, { ...base, labels: ["tier:light"] })).toMatchObject({
      tier: "light",
      model: "sonnet",
      effort: "medium",
      maxTurns: 60,
      advisor: null,
    });
    expect(routeRun("claude", defaultRouting, { ...base, labels: ["tier:heavy"] })).toMatchObject({
      model: "opus",
      effort: "high",
      maxTurns: 200,
    });
  });

  it("cố vấn của cấp được truyền đi", () => {
    const cfg = {
      ...defaultRouting,
      tiers: { ...defaultRouting.tiers, medium: { ...defaultRouting.tiers.medium, advisor: "opus" } },
    };
    expect(routeRun("claude", cfg, base)).toMatchObject({ model: "sonnet", effort: "high", advisor: "opus" });
  });

  it("codex chỉ nhận effort, giữ model đã cấu hình", () => {
    const r = routeRun("codex", defaultRouting, { ...base, labels: ["tier:heavy"] });
    expect(r).toMatchObject({ tier: "heavy", model: null, effort: "high", maxTurns: null, advisor: null });
  });

  it("tắt định tuyến hoặc CLI khác thì null", () => {
    expect(routeRun("claude", { ...defaultRouting, enabled: false }, base)).toBeNull();
    expect(routeRun("gemini", defaultRouting, base)).toBeNull();
    expect(routeRun("antigravity", defaultRouting, base)).toBeNull();
  });

  it("ánh xạ tuỳ chỉnh của dự án được dùng", () => {
    const cfg = {
      ...defaultRouting,
      tiers: {
        ...defaultRouting.tiers,
        medium: { model: "haiku", effort: "low" as const, maxTurns: 10, advisor: null },
      },
    };
    expect(routeRun("claude", cfg, base)).toMatchObject({ model: "haiku", effort: "low", maxTurns: 10 });
  });
});
