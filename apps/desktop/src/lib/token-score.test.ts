import { describe, expect, it } from "vitest";
import { criterion, sampleScore } from "@/lib/token-score.fixture.ts";
import {
  announceTokenScore,
  copyReport,
  formatScore,
  formatValue,
  groupTotals,
  levelOf,
  needsSessionTip,
  onTokenScoreChanged,
  type Status,
  scoreDelta,
  sortCriteria,
  TOKEN_SCORE_UPDATED,
  tokenScore,
  tokenScoreFix,
  tokenScoreFixPreview,
  tokenScoreHistory,
  tokenScoreLast,
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

  it("không gói nào có token thì chỉ lấy gói có điểm và có điểm nhóm A", () => {
    const score = sampleScore();
    for (const p of score.profiles) p.share = 0;
    const [claude, codex] = score.profiles;
    if (!claude || !codex) throw new Error("fixture thiếu gói");
    // Gói codex được tính nhưng chưa có điểm: Go bỏ nó khỏi trung bình, nên nhóm A chỉ còn của claude.
    codex.score = null;
    expect(groupTotals(score).A.earned).toBeCloseTo(15);
    expect(groupTotals(score).A.max).toBeCloseTo(38);
    // Gói có điểm nhưng nhóm A không có điểm tối đa cũng bị bỏ.
    codex.score = 75;
    claude.groups.A = { earned: 0, max: 0 };
    expect(groupTotals(score).A).toEqual({ earned: 10, max: 20 });
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

describe("needsSessionTip", () => {
  function withValues(a1: Status, b2: number | undefined) {
    const score = sampleScore();
    const claude = score.profiles[0];
    if (!claude) throw new Error("fixture thiếu gói");
    claude.criteria = [
      criterion("A1", { status: a1, earned: 10, max: 10 }),
      criterion("B2", b2 === undefined ? { status: "unknown" } : { status: "low", value: b2 }),
    ];
    for (const p of score.profiles.slice(1)) p.counted = false;
    return score;
  }

  it("hiện khi A1 đủ điểm và B2 từ 50% trở lên", () => {
    expect(needsSessionTip(withValues("ok", 0.5))).toBe(true);
    expect(needsSessionTip(withValues("ok", 0.49))).toBe(false);
  });

  it("không hiện khi A1 chưa đủ điểm (việc cần làm là sửa cấu hình) hay B2 chưa đo", () => {
    expect(needsSessionTip(withValues("partial", 0.9))).toBe(false);
    expect(needsSessionTip(withValues("ok", undefined))).toBe(false);
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
    await tokenScoreHistory();
    await tokenScoreHistory(7);
    expect(calls.slice(5)).toEqual([
      { command: "token_score_history", args: { days: 30 } },
      { command: "token_score_history", args: { days: 7 } },
    ]);
    calls.length = 5;
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

describe("onTokenScoreChanged", () => {
  it("nghe cả thông báo trong cửa sổ lẫn sự kiện của Rust, và ngừng sau khi huỷ", async () => {
    let rustHandler: ((e: { payload: null }) => void) | undefined;
    let unlistened = false;
    window.__TAURI__ = {
      core: { invoke: async <T>() => ({}) as T },
      event: {
        listen: async (event, handler) => {
          expect(event).toBe(TOKEN_SCORE_UPDATED);
          rustHandler = handler as (e: { payload: null }) => void;
          return () => {
            unlistened = true;
          };
        },
      },
    };
    let calls = 0;
    const stop = onTokenScoreChanged(() => calls++);
    await Promise.resolve();
    announceTokenScore();
    rustHandler?.({ payload: null });
    expect(calls).toBe(2);
    stop();
    await Promise.resolve();
    announceTokenScore();
    expect(calls).toBe(2);
    expect(unlistened).toBe(true);
  });
});

describe("lịch sử", () => {
  const entry = { ts: "2026-10-19T08:00:00Z", day: "2026-10-19", scoreVersion: 2, machine: 61 };

  function fakeEntries(entries: unknown[]) {
    const calls: string[] = [];
    window.__TAURI__ = {
      core: {
        invoke: async <T>(command: string) => {
          calls.push(command);
          return { entries } as T;
        },
      },
    };
    return calls;
  }

  it("tokenScoreHistory trả danh sách dòng", async () => {
    fakeEntries([entry]);
    expect(await tokenScoreHistory(30)).toEqual([entry]);
  });

  it("tokenScoreLast lấy dòng cuối, null khi chưa có lần tính nào", async () => {
    const calls = fakeEntries([{ ...entry, day: "2026-10-18" }, entry]);
    expect(await tokenScoreLast()).toEqual(entry);
    expect(calls).toEqual(["token_score_last"]);
    fakeEntries([]);
    expect(await tokenScoreLast()).toBeNull();
  });
});
