import type { DeliveryEvent } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import { applyDeliveryEvent, type DeployOutcome, isSettled } from "./job-events.ts";

const JOB = "11111111-1111-4111-8111-111111111111";
const T = (n: number) => `2026-10-23T10:00:${String(n).padStart(2, "0")}.000Z`;
const queued: DeployOutcome = {
  state: "queued",
  steps: [],
  external: null,
  health: null,
  startedAt: null,
  finishedAt: null,
};
const ev = (seq: number, rest: Record<string, unknown>) => ({ jobId: JOB, seq, at: T(seq), ...rest }) as DeliveryEvent;
const run = (events: DeliveryEvent[], from = queued) => events.reduce(applyDeliveryEvent, from);

describe("applyDeliveryEvent", () => {
  it("started chuyển queued sang running và ghi giờ bắt đầu một lần", () => {
    const a = run([ev(0, { type: "started", workerId: "m1" })]);
    expect(a.state).toBe("running");
    expect(a.startedAt).toBe(T(0));
    expect(run([ev(1, { type: "started", workerId: "m1" })], a).startedAt).toBe(T(0));
  });

  it("step thêm bước chưa có, cập nhật bước đã có, giữ giờ bắt đầu", () => {
    const a = run([
      ev(0, { type: "started", workerId: "m1" }),
      ev(1, { type: "step", name: "deploy", state: "running" }),
      ev(2, { type: "step", name: "deploy", state: "succeeded", exitCode: 0 }),
    ]);
    expect(a.steps).toEqual([
      { key: "deploy", state: "succeeded", startedAt: T(1), finishedAt: T(2), exitCode: 0, message: null },
    ]);
  });

  it("bước bị bỏ qua không có giờ bắt đầu", () => {
    const a = run([ev(0, { type: "step", name: "backup", state: "skipped" })]);
    expect(a.steps[0]).toMatchObject({ state: "skipped", startedAt: null });
  });

  it("external được lưu", () => {
    const a = run([ev(0, { type: "external", ref: "billing#42", url: "https://ci.example.invalid/42" })]);
    expect(a.external).toEqual({ label: "billing#42", url: "https://ci.example.invalid/42" });
  });

  it("finished thành công", () => {
    const a = run([ev(0, { type: "started", workerId: "m" }), ev(1, { type: "finished", state: "succeeded" })]);
    expect(a.state).toBe("succeeded");
    expect(a.finishedAt).toBe(T(1));
  });

  it("lỗi: bước đang chạy hỏng và mang thông điệp, bước chưa chạy bị bỏ qua", () => {
    const a = run([
      ev(0, { type: "step", name: "upload", state: "succeeded" }),
      ev(1, { type: "step", name: "deploy", state: "running" }),
      ev(2, { type: "finished", state: "failed", error: { code: "timeout", message: "Quá thời gian." } }),
    ]);
    expect(a.state).toBe("failed");
    expect(a.steps.map((s) => [s.key, s.state])).toEqual([
      ["upload", "succeeded"],
      ["deploy", "failed"],
    ]);
    expect(a.steps[1]?.message).toBe("Quá thời gian.");
  });

  it("huỷ: bước đang chạy và chưa chạy đều thành canceled", () => {
    const base: DeployOutcome = {
      ...queued,
      state: "running",
      steps: [
        { key: "a", state: "running", startedAt: T(0), finishedAt: null, exitCode: null, message: null },
        { key: "b", state: "pending", startedAt: null, finishedAt: null, exitCode: null, message: null },
      ],
    };
    const a = run([ev(5, { type: "finished", state: "canceled" })], base);
    expect(a.steps.map((s) => s.state)).toEqual(["canceled", "canceled"]);
    expect(a.state).toBe("canceled");
  });

  it("sau khi xong, sự kiện đến muộn bị bỏ", () => {
    const done = run([ev(0, { type: "finished", state: "failed" })]);
    expect(isSettled(done.state)).toBe(true);
    expect(
      run([ev(1, { type: "finished", state: "succeeded" }), ev(2, { type: "started", workerId: "m" })], done),
    ).toBe(done);
  });
});
