import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkProposal,
  type OutboxStatus,
  outboxDrop,
  outboxExport,
  outboxRetry,
  outboxStatus,
  rejectedItems,
  submitMemory,
  waitingItems,
} from "@/lib/outbox.ts";

const payload = { projectId: "0a0a0a0a-0000-4000-8000-000000000001", kind: "note" as const, content: "Dùng pnpm." };
afterEach(() => {
  delete window.__TAURI__;
  vi.restoreAllMocks();
});
function fake(reply: unknown) {
  const invoke = vi.fn(async () => reply);
  window.__TAURI__ = { core: { invoke: invoke as <T>() => Promise<T> } };
  return invoke;
}
describe("hộp thư đi qua worker", () => {
  it.each(["queued", "accepted", "duplicate", "held", "rejected"])(
    "trả trạng thái %s của chính lần submit, không flush hàng đợi khác",
    async (state) => {
      const reply = { key: "key", state, result: { code: "FORBIDDEN", reason: "Không có quyền." } };
      const invoke = fake(reply);
      expect(await submitMemory(payload)).toEqual(reply);
      expect(invoke.mock.calls).toEqual([["outbox_submit", { kind: "memory.propose", payload }]]);
    },
  );
  it("sidecar không chạy thì báo lỗi, không gọi thẳng hub", async () => {
    const invoke = fake(null).mockRejectedValue(new Error("Sidecar hive-worker không chạy."));
    await expect(submitMemory(payload)).rejects.toThrow("Sidecar hive-worker không chạy.");
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("chỉ chuyển khoá cho retry, drop, export; đường dẫn do hộp chọn file của Rust quyết định", async () => {
    const invoke = fake(null);
    await outboxRetry("k");
    await outboxDrop("k");
    await outboxExport("k");
    await outboxStatus();
    expect(invoke.mock.calls).toEqual([
      ["outbox_retry", { key: "k" }],
      ["outbox_drop", { key: "k" }],
      ["outbox_export", { key: "k" }],
      ["outbox_status", undefined],
    ]);
  });
  it("đề xuất bị từ chối không báo đã gửi", () => {
    expect(() =>
      checkProposal({ key: "k", state: "rejected", result: { code: "CONFLICT", reason: "Phiên bản đã đổi." } }),
    ).toThrow("CONFLICT: Phiên bản đã đổi.");
  });
  it("phân loại cả mục đang giữ", () => {
    const status: OutboxStatus = {
      hub: "down",
      pending: 2,
      held: 1,
      rejected: 1,
      expired: 1,
      items: ["pending", "sending", "held", "rejected", "expired"].map((state) => ({
        key: state,
        kind: "doc_propose",
        state: state as OutboxStatus["items"][number]["state"],
        attempts: 0,
        createdAt: "2026-10-23",
      })),
    };
    expect(waitingItems(status).map((i) => i.state)).toEqual(["pending", "sending"]);
    expect(rejectedItems(status).map((i) => i.state)).toEqual(["held", "rejected", "expired"]);
  });
});
