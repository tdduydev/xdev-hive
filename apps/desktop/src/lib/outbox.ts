import type { MemoryProposePayload } from "@xdev-hive/contracts";
import { invoke } from "@/lib/tauri.ts";

/*
 * Cầu nối tới `hive-worker outbox` (spec 029 T024, specs/027). Hàng đợi nằm ở worker: việc xếp vào còn trên đĩa khi
 * app tắt hay hub vắng, và worker gửi lại. Kiểu khớp `outboxItemView`, `outboxStatusView`, `outboxFlushView` ở
 * worker/cmd/hive-worker/outbox.go.
 */

export type OutboxState = "pending" | "sending" | "accepted" | "duplicate" | "rejected" | "expired" | "held";

export interface OutboxItem {
  key: string;
  /** memory.propose | project.token_usage | machine.token_score */
  kind: string;
  stream: string;
  source: string;
  state: OutboxState;
  attempts: number;
  createdAt: string;
  nextAttemptAt?: string;
  lastError?: string;
  /** Mã và lý do hub trả khi từ chối. */
  code?: string;
  reason?: string;
}

export interface OutboxStatus {
  /** false khi máy chưa đăng ký với hub: chưa có gì để gửi. */
  registered: boolean;
  pending: number;
  rejected: number;
  expired: number;
  sentRecent: number;
  items: OutboxItem[];
}

export interface OutboxOutcome {
  key: string;
  kind: string;
  state: OutboxState;
  code?: string;
  reason?: string;
  error?: string;
}

export interface OutboxFlush {
  registered: boolean;
  accepted: number;
  duplicate: number;
  rejected: number;
  expired: number;
  held: number;
  retry: number;
  waiting: number;
  /** Lượt này dừng vì không gọi được hub. */
  offline: boolean;
  items: OutboxOutcome[];
  /** Số việc còn chờ gửi (pending, sending) sau lượt này. */
  remaining: number;
}

export const outboxStatus = () => invoke<OutboxStatus>("outbox_status");

export const outboxFlush = () => invoke<OutboxFlush>("outbox_flush");

/** Bỏ một việc khỏi hàng đợi: đóng thẻ việc bị từ chối, hay không muốn gửi nữa. */
export const outboxDrop = (key: string) => invoke<{ dropped: string }>("outbox_drop", { key });

export interface SubmitResult {
  /** Mục vừa xếp. */
  item: OutboxItem;
  /** Kết quả gửi của chính mục này trong lượt flush ngay sau đó; null khi chưa gửi được (mất mạng, hub vắng). */
  outcome: OutboxOutcome | null;
}

/**
 * Xếp một đề xuất memory vào hàng đợi rồi thử gửi ngay. Lỗi lúc gửi không phải lỗi của người dùng: mục đã nằm trong
 * hàng đợi của worker, nên chỉ trả `outcome: null` và để worker thử lại. Chỉ lỗi lúc xếp (máy chưa đăng ký, dữ liệu
 * sai) mới ném ra.
 */
export async function submitMemory(payload: MemoryProposePayload): Promise<SubmitResult> {
  const item = await invoke<OutboxItem>("outbox_submit", { kind: "memory.propose", payload });
  const flushed = await outboxFlush().catch(() => null);
  return { item, outcome: flushed?.items.find((o) => o.key === item.key) ?? null };
}

/** Việc chờ gửi hub: gồm cả mục đang gửi dở. */
export const waitingItems = (status: OutboxStatus) =>
  status.items.filter((i) => i.state === "pending" || i.state === "sending");

/** Việc hub không nhận: bị từ chối (kèm lý do) hay quá hạn chưa gửi được. */
export const rejectedItems = (status: OutboxStatus) =>
  status.items.filter((i) => i.state === "rejected" || i.state === "expired");
