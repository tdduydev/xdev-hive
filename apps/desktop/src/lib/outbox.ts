import type { MemoryProposePayload } from "@xdev-hive/contracts";
import { invoke, onTauriEvent } from "@/lib/tauri.ts";

export type OutboxState = "pending" | "sending" | "accepted" | "duplicate" | "rejected" | "expired" | "held";
export interface OutboxItem {
  key: string;
  kind: string;
  title?: string;
  stream?: string;
  source?: string;
  state: OutboxState;
  attempts: number;
  createdAt: string;
  nextAttemptAt?: string;
  lastError?: string;
  code?: string | null;
  reason?: string | null;
  heldReason?: string | null;
  email?: string;
}
export interface OutboxStatus {
  hub: "up" | "down" | "retrying";
  hubUrl?: string;
  pending: number;
  held: number;
  rejected: number;
  expired: number;
  items: OutboxItem[];
}
export interface OutboxSubmission {
  key: string;
  state: "queued" | "held" | "accepted" | "duplicate" | "rejected" | "expired";
  heldReason?: string;
  reason?: string;
  result?: { code?: string; reason?: string; response?: unknown };
}

export const OUTBOX_KEY = ["outbox"] as const;
export const OUTBOX_REFRESH_MS = 5_000;
export const onOutboxChanged = (refresh: () => void) => onTauriEvent("outbox-changed", refresh);
export const outboxStatus = () => invoke<OutboxStatus>("outbox_status");
export const outboxDrop = (key: string) => invoke<{ dropped: number }>("outbox_drop", { key });
export const outboxRetry = (key: string) => invoke<{ retried: number }>("outbox_retry", { key });
// Rust mở hộp chọn file: cửa sổ web không được chỉ đường dẫn tuỳ ý cho worker ghi.
export const outboxExport = (key: string) => invoke<{ path: string; count: number } | null>("outbox_export", { key });
export const submitMemory = (payload: MemoryProposePayload) =>
  invoke<OutboxSubmission>("outbox_submit", { kind: "memory.propose", payload });
export const waitingItems = (status: OutboxStatus) =>
  status.items.filter((i) => i.state === "pending" || i.state === "sending");
export const rejectedItems = (status: OutboxStatus) =>
  status.items.filter((i) => i.state === "held" || i.state === "rejected" || i.state === "expired");

export function checkProposal(result: OutboxSubmission): OutboxSubmission {
  if (result.state === "rejected" || result.state === "expired") {
    throw new Error(`${result.result?.code ?? result.state}: ${result.result?.reason ?? "Hub không nhận đề xuất."}`);
  }
  return result;
}
