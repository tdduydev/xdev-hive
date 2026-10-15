import { encode } from "uqr";
import { invoke, onTauriEvent } from "@/lib/tauri.ts";

/**
 * Điều khiển từ xa (specs/010-hive-cli-remote): app không tự nói chuyện với worker mà gọi sidecar `hive` qua các lệnh
 * `remote_*` của Rust (src-tauri/src/remote.rs). Kiểu dưới đây khớp JSON của `hive remote … --json`.
 */
export interface RemoteRoot {
  id: string;
  label: string;
  path: string;
}

export interface RemoteDevice {
  id: string;
  label: string;
  userId: string;
  synced: boolean;
  createdAt: string;
}

export interface RemoteStatus {
  enabled: boolean;
  shared: boolean;
  roots: RemoteRoot[];
  devices: RemoteDevice[];
  confirmOnMachine: boolean;
  idleMinutes: number;
  detachedHours: number;
  maxHours: number;
  allowFullAccess: boolean;
  totpOnHttps?: boolean;
  totp?: { enabled: boolean; locked: boolean; lockedUntil?: string };
}

export interface PairInfo {
  pairId: string;
  expiresAt: string;
  url: string;
}

export interface TotpEnroll {
  uri: string;
  secret: string;
  expiresAt: string;
  hubUrl: string;
}

/** Một dòng của `hive ls --json`. hive-worker cũ không có `origin`, `controller` nên chỉ đọc khi có. */
export interface LocalSession {
  id: string;
  cli: string;
  cwd: string;
  account: string;
  started: string;
  controlled: boolean;
  viewers: number;
  origin?: string;
  controller?: string;
}

/** Yêu cầu ghép của điện thoại chờ chủ máy trả lời ("Hỏi trên máy"). */
export interface PairRequest {
  pairId: string;
  label: string;
  userId?: string;
  expiresAt?: string;
}

export interface PairDone {
  pairId: string;
  ok: boolean;
  deviceId?: string;
  reason?: string;
  label?: string;
}

export interface HiveCliStatus {
  available: boolean;
  path: string | null;
  installed: boolean;
  upToDate: boolean;
  onPath: boolean;
  dir: string | null;
}

/** Khoá của `remote_set`; trùng SETTING_KEYS trong remote.rs. */
export type RemoteSettingKey =
  | "confirm-on-machine"
  | "idle-minutes"
  | "detached-hours"
  | "max-hours"
  | "allow-full-access"
  | "totp-on-https";

export const remoteStatus = () => invoke<RemoteStatus>("remote_status");
export const remoteEnable = () => invoke<RemoteStatus>("remote_enable");
export const remoteDisable = () => invoke<RemoteStatus>("remote_disable");
export const remoteRootAdd = (path: string, label?: string) =>
  invoke<RemoteRoot>("remote_root_add", { path, label: label ?? null });
export const remoteRootRemove = (id: string) => invoke<void>("remote_root_remove", { id });
export const remoteDeviceRemove = (id: string) => invoke<void>("remote_device_remove", { id });
export const remotePair = () => invoke<PairInfo>("remote_pair");
export const remoteSet = (key: RemoteSettingKey, value: string) => invoke<RemoteStatus>("remote_set", { key, value });
export const remotePairDecide = (pairId: string, allow: boolean) =>
  invoke<void>("remote_pair_decide", { pairId, allow });
export const remoteTotpEnroll = () => invoke<TotpEnroll>("remote_totp_enroll");
export const remoteTotpConfirm = (code: string) => invoke<void>("remote_totp_confirm", { code });
export const remoteTotpDisable = () => invoke<void>("remote_totp_disable");
export const remoteTotpUnlock = () => invoke<void>("remote_totp_unlock");
export const remoteSessions = () => invoke<LocalSession[]>("remote_sessions");
export const remoteSessionKill = (id: string) => invoke<void>("remote_session_kill", { id });

export const hiveCliStatus = () => invoke<HiveCliStatus>("hive_cli_status");
export const hiveCliInstall = () => invoke<HiveCliStatus>("hive_cli_install");

export const onRemoteState = (handler: (status: RemoteStatus) => void) => onTauriEvent("remote-state", handler);
export const onRemoteSessions = (handler: (e: { sessions: LocalSession[] }) => void) =>
  onTauriEvent("remote-sessions", handler);
export const onRemotePairRequest = (handler: (e: PairRequest) => void) => onTauriEvent("remote-pair-request", handler);
export const onRemotePairDone = (handler: (e: PairDone) => void) => onTauriEvent("remote-pair-done", handler);
export const onRemoteWatch = (handler: (e: { connected: boolean }) => void) => onTauriEvent("remote-watch", handler);

/** Hub chạy HTTP thường: nội dung phiên và phím gõ đi qua mạng không mã hoá. */
export const isHttpHub = (hub: string | null | undefined) => !!hub && /^http:\/\//i.test(hub.trim());

/**
 * Vẽ QR thành một đường SVG duy nhất (mỗi ô đen là một hình chữ nhật): không chèn HTML, và vẽ ở máy nên khoá TOTP
 * không đi qua dịch vụ nào.
 */
export function qrPath(data: string): { size: number; d: string } {
  const { data: modules, size } = encode(data, { ecc: "M", border: 0 });
  let d = "";
  for (let y = 0; y < size; y++) {
    const row = modules[y] ?? [];
    for (let x = 0; x < size; x++) if (row[x]) d += `M${x} ${y}h1v1h-1z`;
  }
  return { size, d };
}
