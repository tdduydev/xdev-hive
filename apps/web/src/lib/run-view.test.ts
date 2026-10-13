import type { RunEventView, RunState } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import {
  budgetPercent,
  canCancel,
  canSteer,
  checkRows,
  describeEvent,
  exploreTokens,
  prLabel,
  routingRows,
  runAccess,
  runPhases,
} from "@/lib/run-view.ts";
import { makeRun } from "@/lib/test-fixtures.ts";

const now = Date.parse("2026-10-11T11:10:00.000Z");
let nextId = 1;
const stateEvent = (to: RunState, at: string, attempt = 1): RunEventView => ({
  id: nextId++,
  attempt,
  seq: null,
  type: "state",
  data: { to },
  createdAt: at,
});
const reached = [
  stateEvent("leased", "2026-10-11T11:00:02.000Z"),
  stateEvent("preparing", "2026-10-11T11:00:10.000Z"),
  stateEvent("running", "2026-10-11T11:01:00.000Z"),
];

describe("runPhases", () => {
  it("đang chạy: các pha trước xong, pha chạy đếm thời gian, pha sau chờ", () => {
    const phases = runPhases(makeRun({ state: "running" }), reached, now);
    expect(phases.map((p) => p.status)).toEqual(["done", "done", "done", "current", "next", "next"]);
    expect(phases[3]?.time).toBe("9 phút");
    expect(phases[1]?.time).not.toBe("");
  });

  it("thành công có PR: mọi pha xong", () => {
    const phases = runPhases(makeRun({ state: "succeeded", prUrl: "https://x/pr/1" }), reached, now);
    expect(phases.every((p) => p.status === "done")).toBe(true);
  });

  it("thành công không PR: pha Mở PR còn chờ", () => {
    const phases = runPhases(makeRun({ state: "no_changes" }), reached, now);
    expect(phases.map((p) => p.status)).toEqual(["done", "done", "done", "done", "done", "next"]);
  });

  it("lỗi: dừng ở pha xa nhất đã tới", () => {
    const phases = runPhases(makeRun({ state: "failed" }), reached, now);
    expect(phases.map((p) => p.status)).toEqual(["done", "done", "done", "stopped", "next", "next"]);
  });

  it("chỉ tính sự kiện của lần thử hiện tại", () => {
    const phases = runPhases(makeRun({ state: "queued", attempt: 2 }), reached, now);
    expect(phases.map((p) => p.status)).toEqual(["current", "next", "next", "next", "next", "next"]);
  });
});

describe("nút theo trạng thái", () => {
  it.each([
    ["running", true, true],
    ["queued", true, true],
    ["verifying", false, true],
    ["cancelling", false, false],
    ["succeeded", false, false],
  ] as const)("%s: gửi chỉ dẫn %s, huỷ %s", (state, steer, cancel) => {
    expect(canSteer(state)).toBe(steer);
    expect(canCancel(state)).toBe(cancel);
  });
});

describe("checkRows", () => {
  const policySnapshot = [
    { check: "changes" as const, required: true, deny: ["infra/prod/**"] },
    { check: "agentReport" as const, required: true },
    { check: "review" as const, required: false, by: "codex" as const, minScore: 7 },
  ];

  it("chưa có kết quả: chờ run kết thúc", () => {
    expect(checkRows(makeRun({ policySnapshot }))).toEqual([
      { label: "Có commit mới, không đụng infra/prod/**", state: "Chờ run kết thúc", tone: "muted" },
      { label: "Agent báo cáo qua task_update", state: "Chờ run kết thúc", tone: "muted" },
      { label: "Review chéo bởi Codex, điểm ≥ 7 (không bắt buộc)", state: "Chờ run kết thúc", tone: "muted" },
    ]);
  });

  it("ghép kết quả theo loại kiểm tra", () => {
    const result = {
      exit: 0,
      commitCount: 1,
      changedFiles: ["a.ts"],
      reasons: [],
      checks: [
        { check: "agentReport", required: true, passed: false, message: "Agent chưa gửi báo cáo." },
        { check: "changes", required: true, passed: true, message: "1 commit, 1 file." },
        { check: "review", required: false, passed: null, message: "Đang chờ review chéo bởi codex." },
      ],
    };
    expect(checkRows(makeRun({ policySnapshot, result })).map((r) => [r.state, r.tone])).toEqual([
      ["Đạt · 1 commit, 1 file.", "ok"],
      ["Không đạt · Agent chưa gửi báo cáo.", "bad"],
      ["Đang chờ review chéo bởi codex.", "muted"],
    ]);
  });

  it("review chéo bỏ qua theo điều kiện", () => {
    const result = {
      exit: 0,
      commitCount: 1,
      changedFiles: ["README.md"],
      reasons: [],
      checks: [{ check: "review", required: false, passed: true, skipped: true, message: "Thay đổi nhỏ." }],
    };
    expect(checkRows(makeRun({ policySnapshot: policySnapshot.slice(2), result }))[0]).toMatchObject({
      state: "Bỏ qua · Thay đổi nhỏ.",
      tone: "muted",
    });
  });
});

describe("describeEvent", () => {
  const ev = (type: string, data: Record<string, unknown>): RunEventView => ({
    id: 1,
    attempt: 1,
    seq: 1,
    type,
    data,
    createdAt: "2026-10-11T11:00:00.000Z",
  });
  it("chuyển trạng thái", () =>
    expect(describeEvent(ev("state", { to: "verifying" }))).toBe("Trạng thái: Đang kiểm kết quả"));
  it("chỉ dẫn", () => expect(describeEvent(ev("steer", { input: "Thêm test" }))).toBe("Chỉ dẫn: Thêm test"));
  it("lý do chờ máy", () =>
    expect(describeEvent(ev("waiting_machine", { message: "Chờ máy dùng chung" }))).toBe("Chờ máy dùng chung"));
  it("bỏ sự kiện cost", () => expect(describeEvent(ev("cost", {}))).toBeNull());
  it("loại lạ thì hiện tên loại", () => expect(describeEvent(ev("mystery", {}))).toBe("mystery"));
});

describe("budgetPercent", () => {
  it("tính phần trăm, chặn ở 100", () => {
    expect(budgetPercent(0.42, 2)).toBe(21);
    expect(budgetPercent(5, 2)).toBe(100);
  });
  it("không có trần hoặc không báo USD", () => {
    expect(budgetPercent(0.42, undefined)).toBeNull();
    expect(budgetPercent(null, 2)).toBeNull();
  });
});

describe("prLabel", () => {
  it.each([
    ["https://github.com/acme/api/pull/128", "#128"],
    ["https://gitlab.com/acme/api/-/merge_requests/12/", "#12"],
    ["https://example.com/pr", "PR"],
  ])("%s → %s", (url, label) => expect(prLabel(url)).toBe(label));
});

describe("runAccess", () => {
  it("run của mình: gửi chỉ dẫn và huỷ được dù không phải quản trị", () => {
    expect(runAccess({ ownerUserId: "u1" }, "u1", false)).toEqual({ steer: true, cancel: true, reason: null });
  });

  it("run của người khác: quản trị đội chỉ huỷ được, không gửi chỉ dẫn vào máy cá nhân của chủ", () => {
    expect(runAccess({ ownerUserId: "u2" }, "u1", true)).toMatchObject({ steer: false, cancel: true });
    expect(runAccess({ ownerUserId: "u2" }, "u1", false)).toMatchObject({ steer: false, cancel: false });
    expect(runAccess({ ownerUserId: "u2" }, "u1", false).reason).toContain("máy cá nhân");
  });

  it("run của đội (không chủ): quản trị đội gửi chỉ dẫn được, thành viên chỉ huỷ được", () => {
    expect(runAccess({ ownerUserId: null }, "u1", true)).toEqual({ steer: true, cancel: true, reason: null });
    expect(runAccess({ ownerUserId: null }, "u1", false)).toMatchObject({ steer: false, cancel: true });
  });
});

describe("exploreTokens", () => {
  it("cộng token vào, ra và cache đọc, ghi", () => {
    expect(
      exploreTokens({
        edited: true,
        turns: 4,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 3000,
        cacheWriteTokens: 400,
      }),
    ).toBe(3520);
  });
});

describe("routingRows", () => {
  const base = {
    tier: "medium" as const,
    baseTier: "medium" as const,
    source: "default" as const,
    model: "sonnet",
    effort: "high" as const,
    advisor: null,
    maxTurns: 120,
    reasons: [],
  };

  it("hiện cấp, nguồn, model, effort và số lượt", () => {
    expect(routingRows(base)).toEqual([
      { term: "Cấp độ", detail: "Vừa" },
      { term: "Nguồn cấp độ", detail: "Mặc định" },
      { term: "Model", detail: "sonnet" },
      { term: "Effort", detail: "high" },
      { term: "Số lượt tối đa", detail: "120" },
    ]);
  });

  it("nói rõ khi nâng cấp vì thử lại, có cố vấn", () => {
    const rows = routingRows({ ...base, tier: "heavy", baseTier: "light", source: "type", advisor: "opus" });
    expect(rows[0]).toEqual({ term: "Cấp độ", detail: "Nặng (nâng từ nhẹ)" });
    expect(rows[1]).toEqual({ term: "Nguồn cấp độ", detail: "Loại task hoặc nhãn" });
    expect(rows).toContainEqual({ term: "Cố vấn", detail: "opus" });
  });

  it("Codex: không có model và số lượt", () => {
    const rows = routingRows({ ...base, model: null, maxTurns: null });
    expect(rows).toContainEqual({ term: "Model", detail: "Theo cấu hình của CLI" });
    expect(rows.some((r) => r.term === "Số lượt tối đa")).toBe(false);
  });
});
