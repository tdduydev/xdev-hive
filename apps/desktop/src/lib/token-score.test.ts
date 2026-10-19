import { describe, expect, it } from "vitest";
import { criterion, sampleScore } from "@/lib/token-score.fixture.ts";
import {
  copyReport,
  formatScore,
  formatValue,
  groupTotals,
  levelOf,
  scoreDelta,
  sortCriteria,
  tokenScore,
  tokenScoreFix,
  tokenScoreFixPreview,
  tokenScoreUndo,
} from "@/lib/token-score.ts";

describe("levelOf", () => {
  it("chia Tốt, Khá, Cần cải thiện đúng ở ranh giới 80 và 60", () => {
    expect([100, 80, 79.99, 60, 59.99, 0].map(levelOf)).toEqual(["good", "good", "fair", "fair", "low", "low"]);
  });
});

describe("sortCriteria", () => {
  it("xếp theo điểm thiếu giảm dần, chưa đo và chưa hỗ trợ xuống cuối, bằng nhau giữ thứ tự gốc", () => {
    const sorted = sortCriteria([
      criterion("A1", { status: "partial", earned: 5, max: 10 }),
      criterion("A2", { status: "unknown", reason: "context_unavailable", earned: 0, max: 20 }),
      criterion("A3", { status: "ok", earned: 5, max: 5 }),
      criterion("B1", { status: "low", earned: 0, max: 12 }),
      criterion("B2", { status: "unsupported", reason: "unsupported_cli", earned: 0, max: 9 }),
      criterion("B3", { status: "low", earned: 0, max: 5 }),
      criterion("B4", { status: "partial", earned: 0, max: 5 }),
    ]);
    expect(sorted.map((c) => c.id)).toEqual(["B1", "A1", "B3", "B4", "A3", "A2", "B2"]);
  });

  it("không đổi mảng gốc", () => {
    const input = [criterion("A1", { status: "ok" }), criterion("A2", { status: "low", earned: 0, max: 8 })];
    sortCriteria(input);
    expect(input.map((c) => c.id)).toEqual(["A1", "A2"]);
  });
});

describe("định dạng", () => {
  it("điểm một chữ số thập phân theo ngôn ngữ", () => {
    expect(formatScore(47.83, "vi")).toBe("47,8");
    expect(formatScore(47.83, "en")).toBe("47.8");
    expect(formatScore(50, "en")).toBe("50.0");
  });

  it("giá trị theo đơn vị: token rút gọn, tỉ lệ là %, đếm là số", () => {
    expect(formatValue(967_000, "tokens", "en")).toBe("967k");
    expect(formatValue(0.3, "ratio", "en")).toBe("30%");
    expect(formatValue(0.972, "ratio", "en")).toBe("97.2%");
    expect(formatValue(3, "count", "en")).toBe("3");
  });
});

describe("điểm nhóm và chênh lệch", () => {
  it("nhóm của máy tính theo tỉ trọng token và bỏ gói không tính", () => {
    const totals = groupTotals(sampleScore());
    // Claude 0,8: A 15/38; Codex 0,2: A 10/20. Gói Antigravity không tính.
    expect(totals.A.earned).toBeCloseTo(0.8 * 15 + 0.2 * 10);
    expect(totals.A.max).toBeCloseTo(0.8 * 38 + 0.2 * 20);
    expect(totals.B.earned).toBeCloseTo(0.8 * 22.5 + 0.2 * 30);
  });

  it("không gói nào có token thì chia đều giữa các gói được tính", () => {
    const score = sampleScore();
    for (const p of score.profiles) p.share = 0;
    expect(groupTotals(score).A.earned).toBeCloseTo((15 + 10) / 2);
  });

  it("chênh lệch so với lần trước làm tròn một chữ số; thiếu một bên thì null", () => {
    const score = sampleScore();
    expect(scoreDelta(score)).toBe(3.5);
    expect(scoreDelta({ ...score, machine: { ...score.machine, score: null } })).toBeNull();
    const { previous: _drop, ...noPrevious } = score;
    expect(scoreDelta(noPrevious)).toBeNull();
    expect(scoreDelta({ ...score, previous: { score: null, at: "2026-10-18T09:00:00Z" } })).toBeNull();
  });
});

describe("copyReport", () => {
  it("chỉ có số, id tiêu chí, trạng thái, mã lý do và tên CLI", () => {
    const score = sampleScore();
    const claude = score.profiles[0];
    if (!claude) throw new Error("fixture thiếu gói");
    // Chuỗi đánh dấu ở mọi chỗ có thể mang dữ liệu riêng (SC-005).
    claude.id = "SECRET-PROFILE-ID";
    claude.label = "SECRET-LABEL";
    claude.projects = [{ key: "SECRET-KEY", path: "~/SECRET/PATH", share: 1, codegraph: false }];
    claude.context = [{ name: "SECRET-CONTEXT-GROUP", tokens: 1 }];
    const a2 = claude.criteria.find((c) => c.id === "A2");
    if (!a2) throw new Error("fixture thiếu A2");
    a2.items = [{ id: "bash", status: "ok", score: 1, file: "~/SECRET/settings.json" }];
    a2.warnings = [{ code: "user_set", file: "~/SECRET/settings.json" }];
    a2.reason = "~/SECRET/free text";
    const text = copyReport(score);
    expect(text).not.toContain("SECRET");
    const parsed = JSON.parse(text);
    expect(parsed.machine.score).toBe(55);
    expect(parsed.previous).toEqual({ score: 51.5 });
    expect(parsed.profiles.map((p: { cli: string }) => p.cli)).toEqual(["claude", "codex", "antigravity"]);
    const first = parsed.profiles[0];
    expect(Object.keys(first)).not.toContain("id");
    expect(Object.keys(first)).not.toContain("projects");
    expect(first.criteria[0].id).toBe("A1");
    expect(first.criteria[1].items).toEqual([{ id: "bash", status: "ok", score: 1 }]);
    expect(first.criteria[1].warnings).toEqual(["user_set"]);
    expect(parsed.profiles[2]).toMatchObject({ counted: false, reason: "no_token_logs" });
  });
});

describe("lệnh invoke", () => {
  function fakeTauri() {
    const calls: { command: string; args?: Record<string, unknown> | undefined }[] = [];
    window.__TAURI__ = {
      core: {
        invoke: async <T>(command: string, args?: Record<string, unknown>) => {
          calls.push({ command, args });
          return {} as T;
        },
      },
    };
    return calls;
  }

  it("chỉ gửi id sửa nhanh, id gói và khoá dự án", async () => {
    const calls = fakeTauri();
    await tokenScore();
    await tokenScore(true, "claude-2");
    await tokenScoreFixPreview("optimizer.balanced", "claude-2");
    await tokenScoreFix("codegraph.init", "claude-2", "p1");
    await tokenScoreUndo("optimizer.balanced", "claude-2", null, "20261019T000000Z");
    expect(calls).toEqual([
      { command: "token_score", args: { fresh: false, profileId: null } },
      { command: "token_score", args: { fresh: true, profileId: "claude-2" } },
      {
        command: "token_score_fix_preview",
        args: { fixId: "optimizer.balanced", profileId: "claude-2", projectKey: null },
      },
      { command: "token_score_fix", args: { fixId: "codegraph.init", profileId: "claude-2", projectKey: "p1" } },
      {
        command: "token_score_undo",
        args: { fixId: "optimizer.balanced", profileId: "claude-2", projectKey: null, backup: "20261019T000000Z" },
      },
    ]);
  });
});
