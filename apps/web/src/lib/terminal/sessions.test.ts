import type { RemoteMachine, RemoteSession } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import {
  formatBytes,
  groupSessions,
  machineRemoteKind,
  remoteEndReasonText,
  sessionDurationMs,
  sessionsOfTask,
  sessionsWithTask,
  sessionTitle,
} from "@/lib/terminal/sessions.ts";

const session = (over: Partial<RemoteSession> = {}): RemoteSession => ({
  id: "s1",
  machineId: "m1",
  machineName: "box",
  ownerId: "u1",
  ownerName: "An",
  isOwner: true,
  origin: "local",
  cli: "claude",
  accountLabel: null,
  cwdLabel: "~/code/payment-api",
  projectId: null,
  projectKey: null,
  taskId: null,
  taskKey: null,
  state: "running",
  visibility: "private",
  remote: true,
  controller: null,
  cols: 120,
  rows: 32,
  exitCode: null,
  endReason: null,
  bytes: 0,
  createdAt: "2026-10-14T01:00:00.000Z",
  endedAt: null,
  ...over,
});

describe("groupSessions", () => {
  it("đưa phiên đang chạy lên trước, mỗi nhóm mới nhất trước", () => {
    const grouped = groupSessions([
      session({ id: "old-ended", state: "closed", createdAt: "2026-10-10T00:00:00.000Z" }),
      session({ id: "live-old", createdAt: "2026-10-13T00:00:00.000Z" }),
      session({ id: "new-ended", state: "failed", createdAt: "2026-10-12T00:00:00.000Z" }),
      session({ id: "live-new", state: "opening", createdAt: "2026-10-14T00:00:00.000Z" }),
    ]);
    expect(grouped.live.map((s) => s.id)).toEqual(["live-new", "live-old"]);
    expect(grouped.ended.map((s) => s.id)).toEqual(["new-ended", "old-ended"]);
  });

  it("không sửa mảng đầu vào", () => {
    const input = [session({ id: "a", createdAt: "2026-10-01T00:00:00.000Z" }), session({ id: "b" })];
    groupSessions(input);
    expect(input.map((s) => s.id)).toEqual(["a", "b"]);
  });
});

describe("phiên theo task", () => {
  const list = [
    session({ id: "a", taskId: "t1", taskKey: "PAY-1" }),
    session({ id: "b", taskId: "t2", taskKey: "PAY-2", createdAt: "2026-10-15T00:00:00.000Z" }),
    session({ id: "c" }),
  ];

  it("lọc đúng task", () => {
    expect(sessionsOfTask(list, "t1").map((s) => s.id)).toEqual(["a"]);
    expect(sessionsOfTask(list, "nope")).toEqual([]);
  });

  it("chỉ lấy phiên có gắn task, mới nhất trước", () => {
    expect(sessionsWithTask(list).map((s) => s.id)).toEqual(["b", "a"]);
  });
});

describe("sessionTitle", () => {
  it("ưu tiên mã task, rồi dự án, rồi nhãn thư mục", () => {
    expect(sessionTitle(session({ taskKey: "PAY-1", projectKey: "PAY" }))).toBe("PAY-1 · ~/code/payment-api");
    expect(sessionTitle(session({ projectKey: "PAY" }))).toBe("PAY · ~/code/payment-api");
    expect(sessionTitle(session())).toBe("~/code/payment-api");
  });

  it("không có gì để gọi thì dùng tên CLI", () => {
    expect(sessionTitle(session({ cwdLabel: null }))).toBe("claude");
  });
});

describe("sessionDurationMs", () => {
  it("phiên đã kết thúc tính tới endedAt, phiên đang chạy tính tới now", () => {
    const start = "2026-10-14T01:00:00.000Z";
    expect(sessionDurationMs({ createdAt: start, endedAt: "2026-10-14T01:05:00.000Z" }, 0)).toBe(300_000);
    expect(sessionDurationMs({ createdAt: start, endedAt: null }, Date.parse(start) + 1000)).toBe(1000);
  });

  it("đồng hồ lệch (now trước lúc mở) không ra số âm", () => {
    expect(sessionDurationMs({ createdAt: "2026-10-14T01:00:00.000Z", endedAt: null }, 0)).toBe(0);
  });
});

describe("formatBytes", () => {
  it("đổi đơn vị theo bậc 1024 và dùng dấu phẩy thập phân", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(812)).toBe("812 B");
    expect(formatBytes(12_595)).toBe("12,3 KB");
    expect(formatBytes(4 * 1024 * 1024)).toBe("4,0 MB");
  });
});

describe("machineRemoteKind", () => {
  const machine = (over: Partial<RemoteMachine> = {}) => ({
    online: true,
    terminal: true,
    remote: { enabled: true } as RemoteMachine["remote"],
    ...over,
  });

  it("máy offline thắng mọi trạng thái khác", () => {
    expect(machineRemoteKind(machine({ online: false, terminal: false, remote: null }))).toBe("offline");
  });

  it("phân biệt worker cũ, máy chưa báo, đang tắt và đang bật", () => {
    expect(machineRemoteKind(machine({ terminal: false }))).toBe("unsupported");
    expect(machineRemoteKind(machine({ remote: null }))).toBe("unreported");
    expect(machineRemoteKind(machine({ remote: { enabled: false } as RemoteMachine["remote"] }))).toBe("off");
    expect(machineRemoteKind(machine())).toBe("on");
  });
});

describe("remoteEndReasonText", () => {
  it("đổi mã đã biết thành câu theo ngôn ngữ", () => {
    expect(remoteEndReasonText(session({ state: "closed", endReason: "idle" }), "vi")).toContain("không hoạt động");
    expect(remoteEndReasonText(session({ state: "closed", endReason: "exit" }), "en")).toBe("The CLI exited.");
  });

  it("mã lạ giữ nguyên, không có mã thì nói theo trạng thái", () => {
    expect(remoteEndReasonText(session({ state: "closed", endReason: "worker_gone" }), "vi")).toBe("worker_gone");
    expect(remoteEndReasonText(session({ state: "failed" }), "vi")).toBe("Phiên bị lỗi.");
    expect(remoteEndReasonText(session({ state: "closed" }), "vi")).toBe("Phiên đã kết thúc.");
  });
});
