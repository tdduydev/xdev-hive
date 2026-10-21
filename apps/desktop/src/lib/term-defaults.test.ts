import { describe, expect, it } from "vitest";
import type { CliProfile } from "@/lib/agent.ts";
import { pickPlan, usablePlans } from "@/lib/term-defaults.ts";

const plan = (id: string, over: Partial<CliProfile> = {}): CliProfile => ({
  id,
  label: id,
  cli: "claude",
  enabled: true,
  priority: 1,
  maxConcurrent: 1,
  cooldownMinutes: 0,
  supported: true,
  loggedIn: true,
  ...over,
});

describe("pickPlan", () => {
  const plans = [
    plan("claude-2", { priority: 10 }),
    plan("claude-3", { priority: 50 }),
    plan("claude-4", { enabled: false, priority: 99 }),
    plan("claude-5", { loggedIn: false, priority: 99 }),
    // Antigravity: app không kiểm được đăng nhập.
    plan("agy-1", { cli: "antigravity", loggedIn: null }),
  ];

  it("chỉ lấy gói đang bật, không biết là đăng xuất, ưu tiên cao trước", () => {
    expect(usablePlans(plans, "claude").map((p) => p.id)).toEqual(["claude-3", "claude-2"]);
    expect(usablePlans(plans, "antigravity").map((p) => p.id)).toEqual(["agy-1"]);
  });

  it("giữ gói nhớ khi còn dùng được, không thì gói ưu tiên cao nhất", () => {
    expect(pickPlan(plans, "claude", "claude-2")).toBe("claude-2");
    expect(pickPlan(plans, "claude", "claude-4")).toBe("claude-3");
    expect(pickPlan(plans, "claude", undefined)).toBe("claude-3");
    expect(pickPlan(plans, "codex", undefined)).toBeNull();
  });

  it("giữ lựa chọn đăng nhập mặc định; shell không có gói", () => {
    expect(pickPlan(plans, "claude", null)).toBeNull();
    expect(pickPlan(plans, "shell", "claude-2")).toBeNull();
  });

  it("chưa đọc được danh sách gói thì giữ gói đã nhớ", () => {
    expect(pickPlan([], "claude", "claude-2")).toBe("claude-2");
    expect(pickPlan([], "claude", undefined)).toBeNull();
  });
});
