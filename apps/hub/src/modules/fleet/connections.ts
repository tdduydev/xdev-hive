import { randomUUID } from "node:crypto";
import { type HubToWorker, hubToWorker, PROTOCOL_VERSION } from "@xdev-hive/contracts/worker-protocol";
import type WebSocket from "ws";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** Gói hub gửi đi; sendToMachine tự điền `v`, và `id` nếu người gọi không đặt. */
export type OutgoingMessage = DistributiveOmit<HubToWorker, "v" | "id"> & { id?: string };

/** Đóng kết nối cũ khi cùng máy nối lại (worker khởi động lại trước khi hub thấy kết nối cũ chết). */
export const CLOSE_REPLACED = 4409;

/**
 * Kết nối WSS của các máy, giữ trong bộ nhớ của tiến trình gateway. Chỉ máy đã qua bước hello mới có mặt ở đây.
 * Nhiều tiến trình gateway thì mỗi tiến trình chỉ biết máy nối vào nó; module runs phải tìm đúng tiến trình (sau này
 * qua NOTIFY) chứ không coi `false` là máy offline.
 */
const sockets = new Map<string, WebSocket>();

export function registerConnection(machineId: string, ws: WebSocket): void {
  const old = sockets.get(machineId);
  sockets.set(machineId, ws);
  if (old && old !== ws) old.close(CLOSE_REPLACED, "Máy đã nối lại bằng kết nối khác");
}

/** Gỡ kết nối khỏi bảng. Trả false khi máy đã có kết nối mới hơn, để người gọi không ghi máy offline nhầm. */
export function unregisterConnection(machineId: string, ws: WebSocket): boolean {
  if (sockets.get(machineId) !== ws) return false;
  sockets.delete(machineId);
  return true;
}

export function isConnected(machineId: string): boolean {
  return sockets.has(machineId);
}

/**
 * Gửi một gói tới máy (id trong bảng machines). Kiểm gói bằng zod trước khi gửi để lỗi lập trình nổi ngay ở hub thay
 * vì làm worker đóng kết nối. Trả false khi máy không nối vào tiến trình này.
 */
export function sendToMachine(machineId: string, msg: OutgoingMessage): boolean {
  const ws = sockets.get(machineId);
  if (!ws || ws.readyState !== ws.OPEN) return false;
  const full = hubToWorker.parse({ id: randomUUID(), ...msg, v: PROTOCOL_VERSION });
  ws.send(JSON.stringify(full));
  return true;
}

/** Đóng kết nối của máy (vd. vừa bị thu hồi). */
export function disconnectMachine(machineId: string, code: number, reason: string): boolean {
  const ws = sockets.get(machineId);
  if (!ws) return false;
  ws.close(code, reason);
  return true;
}
