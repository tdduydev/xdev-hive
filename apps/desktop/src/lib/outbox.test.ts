import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type OutboxFlush,
  type OutboxItem,
  type OutboxStatus,
  outboxFlush,
  outboxStatus,
  rejectedItems,
  submitMemory,
  waitingItems,
} from "@/lib/outbox.ts";

const PROJECT_ID = "0a0a0a0a-0000-4000-8000-000000000001";
const at = "2026-10-23T08:00:00Z";
const payload = { projectId: PROJECT_ID, kind: "note" as const, content: "Dùng pnpm." };

const item = (over: Partial<OutboxItem> = {}): OutboxItem => ({
  key: "01J9ZQ8M3K4N5P6R7S8T9V0W1X",
  kind: "memory.propose",
  stream: "memory.propose",
  source: "desktop",
  state: "pending",
  attempts: 0,
  createdAt: at,
  ...over,
});

const flush = (over: Partial<OutboxFlush> = {}): OutboxFlush => ({
  registered: true,
  accepted: 0,
  duplicate: 0,
  rejected: 0,
  expired: 0,
  held: 0,
  retry: 0,
  waiting: 0,
  offline: false,
  items: [],
  remaining: 0,
  ...over,
});

/** Sidecar giả sau các lệnh `outbox_*`; ghi lại lệnh và đối số. */
function fakeOutbox(replies: Record<string, unknown | (() => unknown)>) {
  const calls: { command: string; args?: Record<string, unknown> | undefined }[] = [];
  window.__TAURI__ = {
    core: {
      invoke: async <T>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        const reply = replies[command];
        if (reply === undefined) throw new Error(`lệnh chưa giả: ${command}`);
        if (typeof reply === "function") return (reply as () => T)();
        return reply as T;
      },
    },
  };
  return calls;
}

afterEach(() => {
  delete window.__TAURI__;
  vi.restoreAllMocks();
});

describe("submitMemory", () => {
  it("xếp đề xuất vào hộp thư đi rồi thử gửi ngay", async () => {
    const queued = item();
    const calls = fakeOutbox({
      outbox_submit: queued,
      outbox_flush: flush({ accepted: 1, items: [{ key: queued.key, kind: queued.kind, state: "accepted" }] }),
    });
    const result = await submitMemory(payload);
    expect(calls.map((c) => c.command)).toEqual(["outbox_submit", "outbox_flush"]);
    expect(calls[0]?.args).toEqual({ kind: "memory.propose", payload });
    expect(result.item).toEqual(queued);
    expect(result.outcome?.state).toBe("accepted");
  });

  it("lỗi mạng khi gửi thì việc vẫn nằm trong hàng đợi, không báo lỗi", async () => {
    const queued = item();
    fakeOutbox({
      outbox_submit: queued,
      outbox_flush: () => {
        throw new Error("Không gọi được hub");
      },
    });
    const result = await submitMemory(payload);
    expect(result.item.state).toBe("pending");
    expect(result.outcome).toBeNull();
  });

  it("hub vắng (offline) thì chưa có kết quả cho mục này", async () => {
    const queued = item();
    fakeOutbox({ outbox_submit: queued, outbox_flush: flush({ offline: true, retry: 1, remaining: 1 }) });
    const result = await submitMemory(payload);
    expect(result.outcome).toBeNull();
  });

  it("hub từ chối thì trả lý do của hub", async () => {
    const queued = item();
    fakeOutbox({
      outbox_submit: queued,
      outbox_flush: flush({
        rejected: 1,
        items: [
          { key: queued.key, kind: queued.kind, state: "rejected", code: "FORBIDDEN", reason: "Không có quyền." },
        ],
      }),
    });
    const result = await submitMemory(payload);
    expect(result.outcome).toMatchObject({ state: "rejected", reason: "Không có quyền." });
  });

  it("không xếp được (máy chưa đăng ký) thì báo lỗi, không thử gửi", async () => {
    const calls = fakeOutbox({
      outbox_submit: () => {
        throw new Error("Máy chưa đăng ký với hub.");
      },
      outbox_flush: flush(),
    });
    await expect(submitMemory(payload)).rejects.toThrow("Máy chưa đăng ký với hub.");
    expect(calls.map((c) => c.command)).toEqual(["outbox_submit"]);
  });
});

describe("danh sách việc", () => {
  const status: OutboxStatus = {
    registered: true,
    pending: 2,
    rejected: 1,
    expired: 1,
    sentRecent: 3,
    items: [
      item({ key: "k-pending-00000000001", state: "pending" }),
      item({ key: "k-sending-00000000002", state: "sending" }),
      item({ key: "k-rejected-0000000003", state: "rejected", reason: "Nội dung trùng." }),
      item({ key: "k-expired-00000000004", state: "expired" }),
      item({ key: "k-accepted-0000000005", state: "accepted" }),
    ],
  };

  it("việc chờ gồm pending và sending", () => {
    expect(waitingItems(status).map((i) => i.state)).toEqual(["pending", "sending"]);
  });

  it("việc bị từ chối gồm rejected và expired, kèm lý do", () => {
    expect(rejectedItems(status).map((i) => i.state)).toEqual(["rejected", "expired"]);
    expect(rejectedItems(status)[0]?.reason).toBe("Nội dung trùng.");
  });

  it("outboxStatus đọc đúng lệnh của sidecar", async () => {
    const calls = fakeOutbox({ outbox_status: status });
    expect(await outboxStatus()).toEqual(status);
    expect(calls).toEqual([{ command: "outbox_status", args: undefined }]);
  });

  it("outboxFlush không gửi đối số", async () => {
    const calls = fakeOutbox({ outbox_flush: flush() });
    await outboxFlush();
    expect(calls).toEqual([{ command: "outbox_flush", args: undefined }]);
  });
});
