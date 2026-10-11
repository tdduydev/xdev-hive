import { describe, expect, it } from "vitest";
import { boardRows, boardStats, filterCounts, filterRows, runActivity, taskBadge } from "./task-board.ts";
import { makeRun, makeTask } from "./test-fixtures.ts";

const now = Date.parse("2026-10-11T12:00:00.000Z");

describe("taskBadge", () => {
  it.each([
    ["chưa giao", makeTask(), null, "Chưa giao", null],
    ["run lỗi trả task về todo", makeTask(), makeRun({ state: "failed" }), "Lỗi", "failed"],
    ["mất máy hết lượt cũng là lỗi", makeTask(), makeRun({ state: "lost" }), "Lỗi", "failed"],
    ["đang chạy theo run", makeTask({ status: "running" }), makeRun({ state: "running" }), "Đang chạy", "running"],
    ["chờ máy", makeTask({ status: "queued" }), makeRun({ state: "queued" }), "Chờ máy", "running"],
    ["kiểm kết quả", makeTask({ status: "running" }), makeRun({ state: "verifying" }), "Đang kiểm kết quả", "running"],
    [
      "có PR chờ review",
      makeTask({ status: "review" }),
      makeRun({ state: "succeeded", prUrl: "u" }),
      "Chờ review PR",
      "review",
    ],
    [
      "kiểm tra mềm không đạt",
      makeTask({ status: "review" }),
      makeRun({ state: "needs_review" }),
      "Cần người xem",
      "review",
    ],
    ["đã merge", makeTask({ status: "done" }), makeRun({ state: "succeeded", prUrl: "u" }), "Đã merge", "done"],
    ["xong không PR", makeTask({ status: "done" }), null, "Xong", "done"],
    ["đã huỷ", makeTask({ status: "cancelled" }), makeRun({ state: "cancelled" }), "Đã huỷ", null],
    ["không có thay đổi", makeTask(), makeRun({ state: "no_changes" }), "Không có thay đổi", null],
    [
      "đang lập kế hoạch (plan mode)",
      makeTask({ status: "queued" }),
      makeRun({ state: "planning" }),
      "Đang lập kế hoạch",
      "running",
    ],
    [
      "chờ duyệt kế hoạch",
      makeTask({ status: "awaiting_plan" }),
      makeRun({ state: "awaiting_plan" }),
      "Chờ duyệt kế hoạch",
      "plan",
    ],
  ] as const)("%s", (_, task, run, label, group) => {
    expect(taskBadge(task, run)).toMatchObject({ label, group });
  });

  it("màu theo design system: đang lập kế hoạch là đang chạy, chờ duyệt là chờ người", () => {
    expect(taskBadge(makeTask({ status: "queued" }), makeRun({ state: "planning" })).tone).toBe("sel");
    expect(taskBadge(makeTask({ status: "awaiting_plan" }), makeRun({ state: "awaiting_plan" })).tone).toBe("warn");
  });
});

describe("runActivity", () => {
  it("chưa chạy", () => expect(runActivity(null, now)).toBe("Chưa chạy"));
  it("đang chạy tính từ startedAt", () =>
    expect(runActivity(makeRun({ state: "running", startedAt: "2026-10-11T11:54:00.000Z" }), now)).toBe(
      "chạy được 6 phút",
    ));
  it("xếp hàng tính từ lúc tạo", () =>
    expect(runActivity(makeRun({ createdAt: "2026-10-11T11:57:00.000Z" }), now)).toBe("xếp hàng 3 phút"));
  it("xong kèm số lần thử", () =>
    expect(runActivity(makeRun({ state: "failed", attempt: 3, finishedAt: "2026-10-11T11:00:00.000Z" }), now)).toBe(
      "xong 1 giờ trước · thử 3/3",
    ));
});

describe("lọc và số liệu", () => {
  const tasks = [
    makeTask({ id: "a", key: "HD-1", title: "Sửa hoá đơn", status: "running", createdAt: "2026-10-11T09:00:00.000Z" }),
    makeTask({
      id: "b",
      key: "HD-2",
      title: "Thêm phân trang",
      status: "review",
      createdAt: "2026-10-11T10:00:00.000Z",
    }),
    makeTask({ id: "c", key: "HD-3", title: "Viết test", status: "todo", createdAt: "2026-10-11T11:00:00.000Z" }),
    makeTask({ id: "d", key: "HD-4", title: "Tài liệu", status: "todo", createdAt: "2026-10-11T08:00:00.000Z" }),
  ];
  const runs = [
    makeRun({ taskId: "a", state: "running", machineId: "m1", cost: { ...makeRun().cost, costUsd: 0.42 } }),
    makeRun({ taskId: "b", state: "succeeded", prUrl: "https://x/pr/1", cost: { ...makeRun().cost, costUsd: 1.18 } }),
    makeRun({ taskId: "c", state: "failed", finishedAt: "2026-10-11T11:30:00.000Z" }),
  ];
  const rows = boardRows(tasks, runs);

  it("việc mới tạo lên đầu", () => expect(rows.map((r) => r.task.key)).toEqual(["HD-3", "HD-2", "HD-1", "HD-4"]));

  it("đếm theo nhóm", () =>
    expect(filterCounts(rows)).toEqual({ all: 4, running: 1, plan: 0, review: 1, failed: 1, done: 0 }));

  it("lọc theo nhóm và tìm không dấu", () => {
    expect(filterRows(rows, "failed", "").map((r) => r.task.key)).toEqual(["HD-3"]);
    expect(filterRows(rows, "all", "hoa don").map((r) => r.task.key)).toEqual(["HD-1"]);
    expect(filterRows(rows, "all", "hd-2").map((r) => r.task.key)).toEqual(["HD-2"]);
    expect(filterRows(rows, "running", "phân trang")).toEqual([]);
  });

  it("bốn ô số liệu", () => {
    expect(boardStats(rows, now)).toEqual([
      { label: "Đang chạy", value: "1", hint: "trên 1 máy" },
      { label: "Chờ review và merge", value: "1", hint: "1 việc đã có PR" },
      { label: "Lỗi trong 24 giờ", value: "1", hint: "HD-3" },
      { label: "Chi phí run gần nhất", value: "1,60 USD", hint: "1 run không báo USD" },
    ]);
  });

  it("bảng rỗng", () => {
    expect(boardStats([], now).map((s) => s.value)).toEqual(["0", "0", "0", "0,00 USD"]);
  });
});
