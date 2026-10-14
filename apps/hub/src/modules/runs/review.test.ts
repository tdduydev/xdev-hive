import { describe, expect, it } from "vitest";
import { reviewPrompt } from "./review.ts";

const base = {
  taskKey: "API-7",
  title: "Hoàn tiền",
  body: null,
  branch: "ai/api-7",
  baseBranch: "main",
  prUrl: null,
};

describe("reviewPrompt", () => {
  it("review chéo cũ: không có quy tắc chấm hay ngữ cảnh spec", () => {
    const prompt = reviewPrompt(base);
    expect(prompt).toContain("7 trở lên là đủ để merge.");
    expect(prompt).not.toContain("hạng mục AI SDLC");
  });

  it("checkpoint AI: ngữ cảnh spec đứng trước diff, quy tắc chấm của checkpoint ngay sau quy tắc chung", () => {
    const prompt = reviewPrompt({
      ...base,
      body: "Mô tả",
      guidance: ["- Ngưỡng đạt của checkpoint này là 8/10."],
      specContext: ["Task thuộc hạng mục AI SDLC 007 · Thanh toán.", "- FR-001: Hệ thống MUST hoàn tiền."],
    });
    const lines = prompt.split("\n");
    const at = (s: string) => lines.findIndex((l) => l.startsWith(s));
    expect(at("Task thuộc hạng mục AI SDLC 007")).toBeGreaterThan(at("Mô tả"));
    expect(at("- FR-001")).toBeLessThan(at("Worktree đang ở nhánh"));
    expect(at("- Ngưỡng đạt của checkpoint này là 8/10.")).toBe(at("- Chấm điểm 0–10") + 1);
  });
});
