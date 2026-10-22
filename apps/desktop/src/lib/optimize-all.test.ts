import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  isOptimizePlan,
  isOptimizeRun,
  type OptimizePlan,
  type OptimizeRun,
  optimizeAllApply,
  optimizeAllLast,
  optimizeAllPreview,
  optimizeAllUndo,
  withSelection,
} from "@/lib/optimize-all.ts";

// Fixture do worker Go sinh ra: kiểu TS phải đọc được đúng các file này.
const load = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(process.cwd(), "../../worker/internal/optimizeall/testdata", name), "utf8"));
const plan = load("optimize-plan.json");
const run = load("optimize-run.json");
const undone = load("optimize-run-undone.json");

describe("kiểu OptimizePlan", () => {
  it("khớp fixture của worker Go", () => {
    expect(isOptimizePlan(plan)).toBe(true);
    const p = plan as OptimizePlan;
    expect(p.scoreBefore).toBe(48);
    expect(p.policySources).toEqual(["acme/web"]);
    expect(p.steps.map((s) => s.group)).toEqual([
      "cli",
      "cli",
      "cli",
      "cli",
      "cli",
      "tools",
      "tools",
      "context",
      "score",
    ]);
    // aggressive không chọn sẵn và cần xác nhận; công cụ đã cài không hoàn tác được.
    const aggressive = p.steps.filter((s) => s.level === "aggressive");
    expect(aggressive).toHaveLength(2);
    expect(aggressive.every((s) => !s.selected && s.requiresConfirm)).toBe(true);
    expect(p.steps.find((s) => s.id === "tool.codegraph")?.undoable).toBe(false);
    expect(p.steps.find((s) => s.id === "optimizer.enable")?.autoCompactWindow).toBe(150000);
  });

  it("từ chối dữ liệu sai hình", () => {
    const base = plan as OptimizePlan;
    const [first, ...rest] = base.steps;
    const withFirst = (patch: object) => ({ ...base, steps: [{ ...first, ...patch }, ...rest] });
    expect(isOptimizePlan(null)).toBe(false);
    expect(isOptimizePlan({ ...base, steps: "x" })).toBe(false);
    expect(isOptimizePlan({ ...base, scoreBefore: "48" })).toBe(false);
    expect(isOptimizePlan(withFirst({ group: "other" }))).toBe(false);
    expect(isOptimizePlan(withFirst({ level: "turbo" }))).toBe(false);
    expect(isOptimizePlan(withFirst({ changes: [{ file: "f" }] }))).toBe(false);
    expect(isOptimizePlan(withFirst({ selected: "yes" }))).toBe(false);
  });
});

describe("kiểu OptimizeRun", () => {
  it("khớp fixture của worker Go", () => {
    expect(isOptimizeRun(run)).toBe(true);
    const r = run as OptimizeRun;
    expect(r.scoreBefore).toBe(48);
    expect(r.scoreAfter).toBe(81);
    expect(r.undoneAt).toBeNull();
    expect(r.steps.find((s) => !s.selected)?.status).toBe("skipped");
    expect(r.steps.every((s) => s.error === null)).toBe(true);
  });

  it("đọc được bản đã hoàn tác", () => {
    expect(isOptimizeRun(undone)).toBe(true);
    const r = undone as OptimizeRun;
    expect(r.undoneAt).not.toBeNull();
    expect(r.steps[0]?.status).toBe("undone");
  });

  it("từ chối dữ liệu sai hình", () => {
    const base = run as OptimizeRun;
    const [first, ...rest] = base.steps;
    const withFirst = (patch: object) => ({ ...base, steps: [{ ...first, ...patch }, ...rest] });
    expect(isOptimizeRun(null)).toBe(false);
    // Kế hoạch chưa chạy không phải nhật ký.
    expect(isOptimizeRun(plan)).toBe(false);
    expect(isOptimizeRun({ ...base, id: 7 })).toBe(false);
    expect(isOptimizeRun(withFirst({ status: "done" }))).toBe(false);
    expect(isOptimizeRun(withFirst({ error: 1 }))).toBe(false);
  });
});

describe("cầu nối tối ưu một chạm", () => {
  it("withSelection chỉ đổi cờ chọn", () => {
    const p = plan as OptimizePlan;
    const next = withSelection(p, (step) => step.id === "context.sync");
    expect(next.steps.filter((s) => s.selected).map((s) => s.id)).toEqual(["context.sync"]);
    const strip = (plan: OptimizePlan) =>
      plan.steps.map((s) => {
        const { selected: _, ...rest } = s;
        return rest;
      });
    expect(strip(next)).toEqual(strip(p));
    // Không đụng bản gốc.
    expect(p.steps.filter((s) => s.selected)).toHaveLength(7);
  });

  it("gửi đúng lệnh và tham số Tauri", async () => {
    const invoke = vi.fn().mockResolvedValue({});
    window.__TAURI__ = { core: { invoke } };
    const policy = { "7f3c1b52-0a1e-4c0e-9d57-2f4c8f0b6a11": { level: "balanced" } };
    await optimizeAllPreview();
    await optimizeAllPreview(policy);
    await optimizeAllApply(plan as OptimizePlan);
    await optimizeAllUndo("01JBRUNID0000000000000000");
    await optimizeAllLast();
    expect(invoke.mock.calls).toEqual([
      ["optimize_all_preview", { policy: null }],
      ["optimize_all_preview", { policy }],
      ["optimize_all_apply", { plan }],
      ["optimize_all_undo", { runId: "01JBRUNID0000000000000000" }],
      ["optimize_all_last", undefined],
    ]);
  });

  it("giữ lỗi tiếng Việt do sidecar trả về", async () => {
    window.__TAURI__ = { core: { invoke: vi.fn().mockRejectedValue("Đang tối ưu ở cửa sổ khác.") } };
    await expect(optimizeAllApply(plan as OptimizePlan)).rejects.toBe("Đang tối ưu ở cửa sổ khác.");
  });
});
