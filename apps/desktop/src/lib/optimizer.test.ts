import { describe, expect, it, vi } from "vitest";
import {
  numericReport,
  type OptimizerReport,
  optimizerDisable,
  optimizerEnable,
  optimizerProfiles,
  optimizerReport,
  optimizerRestore,
  optimizerStatus,
  reportSources,
  rtkNumbers,
  sourceMetrics,
} from "@/lib/optimizer.ts";

describe("cầu nối bộ tối ưu", () => {
  it("gửi đúng lệnh và tham số Tauri, không cần hub", async () => {
    const invoke = vi.fn().mockResolvedValue({ profiles: [] });
    window.__TAURI__ = { core: { invoke } };
    await optimizerStatus();
    await optimizerEnable("claude-2", "aggressive", true);
    await optimizerDisable("claude-2");
    await optimizerRestore("codex-2", "20261014T000000Z");
    await optimizerRestore("codex-2", null);
    await optimizerReport("codex-2");
    expect(invoke.mock.calls).toEqual([
      ["optimizer_status", undefined],
      ["optimizer_enable", { profile: "claude-2", level: "aggressive", rtk: true }],
      ["optimizer_disable", { profile: "claude-2" }],
      ["optimizer_restore", { profile: "codex-2", backup: "20261014T000000Z" }],
      ["optimizer_restore", { profile: "codex-2", backup: null }],
      ["optimizer_report", { profile: "codex-2", days: 7 }],
    ]);
  });

  it("giữ lỗi tiếng Việt do sidecar trả về", async () => {
    window.__TAURI__ = { core: { invoke: vi.fn().mockRejectedValue("File cấu hình hỏng.") } };
    await expect(optimizerEnable("claude", "balanced", false)).rejects.toBe("File cấu hình hỏng.");
  });

  it("thêm lựa chọn mặc định riêng, không nhân đôi gói đã đăng ký", () => {
    const profiles = optimizerProfiles({
      profiles: [
        {
          id: "claude",
          cli: "claude",
          configDir: "/fake/.claude",
          default: true,
          supported: true,
          enabled: true,
          inAccounts: true,
        },
      ],
    });
    expect(profiles.map((p) => p.id)).toEqual(["claude", "codex"]);
    expect(profiles[0]?.enabled).toBe(true);
    expect(profiles[1]?.default).toBe(true);
  });
});

describe("số liệu và clipboard", () => {
  it("tính token quy đổi từ tổng, không nhân lại cache; mẫu rỗng không gây NaN", () => {
    expect(
      sourceMetrics({
        sessions: 5,
        calls: 20,
        weighted: 20000,
        medianPeakContext: 180000,
        peakOver150k: 3,
        peakOver400k: 1,
        cacheHit: 0.95,
      }),
    ).toEqual({ sessions: 5, perCall: 1000, perSession: 4000, peak: 180000, over150k: 3, over400k: 1, cacheHit: 95 });
    expect(sourceMetrics(undefined)).toEqual({
      sessions: 0,
      perCall: null,
      perSession: null,
      peak: null,
      over150k: 0,
      over400k: 0,
      cacheHit: null,
    });
    expect(
      sourceMetrics({
        sessions: 1,
        calls: 0,
        weighted: 0,
        medianPeakContext: 0,
        peakOver150k: 0,
        peakOver400k: 0,
        cacheHit: 0,
      }).perCall,
    ).toBeNull();
  });

  it("chỉ chép trường số cho phép, loại đường dẫn, prompt, lệnh Bash và dữ liệu RTK lạ", () => {
    const report = JSON.parse(
      JSON.stringify({
        days: 7,
        sessions: 5,
        bySource: {
          "claude/interactive": {
            sessions: 5,
            calls: 20,
            weighted: 20000,
            medianPeakContext: 180000,
            peakOver150k: 3,
            peakOver400k: 1,
            cacheHit: 0.95,
            secret: "/private/prompt",
          },
          "/private/session": {},
        },
        split: {
          cutoff: "2026-10-14T00:00:00Z",
          sessionsBefore: 0,
          sessionsAfter: 5,
          before: { bySource: {} },
          after: { bySource: {} },
        },
        memoryInventory: { files: ["/private/memory.md"] },
        bash: [{ name: "cat /private/secret" }],
        tools: [{ name: "prompt text" }],
        trimmed: {
          entries: 2,
          charsBefore: 30000,
          charsAfter: 12000,
          charsCut: 18000,
          byTool: { "/private/tool": {} },
        },
        rtkGain: {
          total_saved: 123,
          command: "private prompt",
          saved_tokens: "/private/tokens",
          private_path: 999,
          nested: { path: "/private" },
        },
      }),
    ) as OptimizerReport;
    expect(reportSources(report)).toEqual(["claude/interactive"]);
    const copied = numericReport(report);
    expect(copied).not.toMatch(/private|prompt|memory|bash|cutoff|byTool/);
    const parsed = JSON.parse(copied);
    expect(parsed.bySource["claude/interactive"].perCall).toBe(1000);
    expect(parsed.trimmed.charsCut).toBe(18000);
    expect(parsed.rtkGain).toEqual({ total_saved: 123 });
  });

  it("giữ nguồn chỉ xuất hiện một phía và chấp nhận thiếu RTK", () => {
    const source = {
      sessions: 1,
      calls: 1,
      weighted: 12,
      medianPeakContext: 5,
      peakOver150k: 0,
      peakOver400k: 0,
      cacheHit: 0,
    };
    expect(
      reportSources({
        days: 7,
        sessions: 1,
        bySource: {},
        split: {
          cutoff: "2026-10-14",
          sessionsBefore: 1,
          sessionsAfter: 0,
          before: { bySource: { "codex/worker": source } },
          after: { bySource: {} },
        },
      }),
    ).toEqual(["codex/worker"]);
    expect(rtkNumbers(null)).toEqual({});
    expect(rtkNumbers({ total_saved: Number.NaN, saved_tokens: Infinity })).toEqual({});
  });
});
