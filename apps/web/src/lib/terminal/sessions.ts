import type { RemoteMachine, RemoteSession } from "@xdev-hive/contracts";
import type { Dict, Lang } from "@/lib/i18n.ts";
import type { Tone } from "@/lib/run-view.ts";
import { isLive } from "@/lib/terminal.ts";

/**
 * Logic thuần của phần Điều khiển từ xa trên web: nhóm phiên, trạng thái từ xa của máy, nhãn. Tách khỏi component để
 * test không cần trình duyệt và để trang danh sách, trang phiên và mục "Phiên tương tác" của task dùng chung.
 */

const byNewest = (a: RemoteSession, b: RemoteSession) => Date.parse(b.createdAt) - Date.parse(a.createdAt);

/** Phiên đang chạy lên trước, mỗi nhóm mới nhất trước: người dùng vào để tìm phiên đang làm dở. */
export function groupSessions(sessions: readonly RemoteSession[]): { live: RemoteSession[]; ended: RemoteSession[] } {
  const sorted = [...sessions].sort(byNewest);
  return { live: sorted.filter(isLive), ended: sorted.filter((session) => !isLive(session)) };
}

/** Phiên gắn với một task, để mục "Phiên tương tác" trên trang task. */
export const sessionsOfTask = (sessions: readonly RemoteSession[], taskId: string): RemoteSession[] =>
  [...sessions].filter((session) => session.taskId === taskId).sort(byNewest);

/** Phiên có gắn task (bảng việc chung không lọc theo task cụ thể). */
export const sessionsWithTask = (sessions: readonly RemoteSession[]): RemoteSession[] =>
  [...sessions].filter((session) => session.taskKey !== null).sort(byNewest);

/** Tên một dòng phiên: việc hay dự án, rồi nhãn thư mục. Nhãn thư mục không bao giờ là đường dẫn tuyệt đối (hợp đồng). */
export function sessionTitle(session: Pick<RemoteSession, "taskKey" | "projectKey" | "cwdLabel" | "cli">): string {
  const scope = session.taskKey ?? session.projectKey;
  return [scope, session.cwdLabel].filter(Boolean).join(" · ") || session.cli;
}

/** Thời lượng phiên; phiên còn chạy tính tới `now`. */
export function sessionDurationMs(session: Pick<RemoteSession, "createdAt" | "endedAt">, now: number): number {
  const start = Date.parse(session.createdAt);
  const end = session.endedAt ? Date.parse(session.endedAt) : now;
  return Number.isNaN(start) || Number.isNaN(end) ? 0 : Math.max(0, end - start);
}

/** 0 B, 812 B, 12,3 KB, 4,0 MB: dung lượng bản ghi của phiên. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1).replace(".", ",")} ${units[unit]}`;
}

export const ORIGIN_LABEL: Record<RemoteSession["origin"], Dict<string>> = {
  local: { vi: "Mở tại máy", en: "Opened at the machine" },
  remote: { vi: "Mở từ điện thoại", en: "Opened from phone" },
};

// ---- Máy ----

export type MachineRemoteKind = "offline" | "unsupported" | "unreported" | "off" | "on";

/**
 * Trạng thái điều khiển từ xa của một máy cho thẻ máy. Thứ tự kiểm quan trọng: máy offline thì mọi thứ khác chỉ là bản
 * hub giữ lần cuối nên "offline" thắng; worker chưa hỗ trợ và máy chưa báo lần nào là hai việc khác nhau (một bên cần
 * cập nhật worker, một bên cần chạy `hive`).
 */
export function machineRemoteKind(machine: Pick<RemoteMachine, "online" | "terminal" | "remote">): MachineRemoteKind {
  if (!machine.online) return "offline";
  if (!machine.terminal) return "unsupported";
  if (machine.remote === null) return "unreported";
  return machine.remote.enabled ? "on" : "off";
}

export const MACHINE_KIND_TONE: Record<MachineRemoteKind, Tone> = {
  offline: "neutral",
  unsupported: "warn",
  unreported: "neutral",
  off: "neutral",
  on: "ok",
};

// ---- Lý do kết thúc ----

/** Lý do worker ghi (`termExitReason`) đổi thành câu; mã lạ thì giữ nguyên chữ hub gửi. */
export function remoteEndReasonText(session: Pick<RemoteSession, "state" | "endReason">, lang: Lang): string {
  const known: Record<string, Dict<string>> = {
    exit: { vi: "CLI đã thoát.", en: "The CLI exited." },
    closed: { vi: "Phiên đã được ngắt.", en: "The session was ended." },
    idle: { vi: "Phiên bị ngắt vì không hoạt động quá lâu.", en: "Ended after being idle for too long." },
    denied: { vi: "Máy từ chối mở phiên.", en: "The machine refused to open the session." },
    error: { vi: "Phiên gặp lỗi.", en: "The session hit an error." },
  };
  const reason = session.endReason;
  if (reason && known[reason]) return known[reason][lang];
  if (reason) return reason;
  if (session.state === "failed") return lang === "en" ? "The session failed." : "Phiên bị lỗi.";
  return lang === "en" ? "The session has ended." : "Phiên đã kết thúc.";
}
