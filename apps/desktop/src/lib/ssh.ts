import type { Dict } from "@/lib/i18n.ts";
import { invoke } from "@/lib/tauri.ts";

/**
 * Máy chủ SSH của máy này (specs/023-desktop-ssh-keys): đọc và ghi qua `hive-worker ssh` (worker/internal/sshkeys).
 * Kiểu khớp JSON của worker. Mật khẩu chỉ đi một chiều vào `sshSetup` và không bao giờ quay lại giao diện.
 */
export interface SshKey {
  path: string;
  exists: boolean;
  type?: string | undefined;
  fingerprint?: string | undefined;
  comment?: string | undefined;
  /** Một dòng của file .pub. */
  publicKey?: string | undefined;
  /** Khoá có passphrase: ssh chỉ dùng được khi ssh-agent đã nạp khoá. */
  encrypted: boolean;
}

export interface SshHost {
  alias: string;
  hostName: string;
  user: string;
  port: number;
  identityFile?: string | undefined;
  /** Khối do app tạo; app chỉ sửa và xoá khối này. */
  managed: boolean;
  /** Đi qua máy trung gian (ProxyJump, ProxyCommand): app không cài khoá được. */
  proxy: boolean;
  /** ssh sẽ đưa khoá của máy khi nối alias này. */
  keyUsable: boolean;
}

export interface SshList {
  /** Đường dẫn ssh của máy; rỗng là chưa có OpenSSH client. */
  ssh: string;
  configPath: string;
  key: SshKey;
  hosts: SshHost[];
}

export type SshStatus =
  | "ok"
  | "auth"
  | "hostkey_changed"
  | "hostkey_unknown"
  | "passphrase"
  | "key_perms"
  | "unreachable"
  | "no_ssh"
  | "error";

export interface SshCheck {
  status: SshStatus;
  detail?: string | undefined;
}

export interface SshScan {
  algorithm: string;
  fingerprint: string;
  known: "known" | "unknown" | "changed";
  /** Lệnh người quản trị chạy trên máy chủ để đọc dấu vân tay thật. */
  adminCommand: string;
}

export interface SshSetup {
  key: SshKey;
  keyCreated: boolean;
  configWritten: boolean;
  check: SshCheck;
}

export interface SshTarget {
  host: string;
  port: number;
  user: string;
  alias: string;
}

/**
 * Worker bản cũ in `"hosts": null` khi máy chưa có ~/.ssh/config (Linux mới cài), và màn SSH trắng vì đọc `.length`
 * của null. Chuẩn hoá ở đây để màn luôn nhận mảng, kể cả khi app chạy cùng sidecar khác bản.
 */
export function normalizeSshList(raw: SshList | null | undefined): SshList {
  const list: Partial<SshList> = raw ?? {};
  const key: Partial<SshKey> = list.key ?? {};
  return {
    ssh: list.ssh ?? "",
    configPath: list.configPath ?? "",
    key: { ...key, path: key.path ?? "", exists: !!key.exists, encrypted: !!key.encrypted },
    hosts: Array.isArray(list.hosts) ? list.hosts : [],
  };
}

export const sshList = () => invoke<SshList>("ssh_list").then(normalizeSshList);
export const sshCheck = (alias: string) => invoke<SshCheck>("ssh_check", { alias });
export const sshScan = (host: string, port: number) => invoke<SshScan>("ssh_scan", { host, port });
export const sshSetup = (target: SshTarget, fingerprint: string, password: string) =>
  invoke<SshSetup>("ssh_setup", { ...target, fingerprint, password });
export const sshRemove = (alias: string) => invoke<SshList>("ssh_remove", { alias }).then(normalizeSshList);
/** Mở terminal của hệ điều hành chạy `ssh <alias>`: ssh tự đọc khối trong ~/.ssh/config, kể cả ProxyJump. */
export const sshOpenTerminal = (alias: string) => invoke<void>("ssh_open_terminal", { alias });

export type SshTone = "ok" | "warn" | "bad";

/** Màu của trạng thái: vàng là việc người dùng tự làm được trong app, đỏ là cần sửa ngoài app hoặc nguy hiểm. */
export function sshTone(status: SshStatus): SshTone {
  if (status === "ok") return "ok";
  if (status === "auth" || status === "hostkey_unknown" || status === "passphrase") return "warn";
  return "bad";
}

/** Nhãn và gợi ý sửa của từng trạng thái kiểm tra (spec US3). */
export const SSH_STATUS_TEXT: Dict<Record<SshStatus, { label: string; hint: string }>> = {
  vi: {
    ok: { label: "Khoá dùng được", hint: "Đăng nhập bằng khoá, không cần mật khẩu." },
    auth: { label: "Cần thiết lập", hint: "Máy chủ chưa nhận khoá của máy này." },
    hostkey_changed: {
      label: "Khoá máy chủ đã đổi",
      hint: "Có thể có người giả mạo máy chủ. Hỏi người quản trị trước khi sửa ~/.ssh/known_hosts.",
    },
    hostkey_unknown: {
      label: "Chưa biết máy chủ",
      hint: "Máy chủ chưa có trong known_hosts. Cài khoá qua app để xác nhận dấu vân tay.",
    },
    passphrase: { label: "Khoá cần passphrase", hint: "Nạp khoá vào ssh-agent (ssh-add) rồi kiểm tra lại." },
    key_perms: {
      label: "Quyền file khoá sai",
      hint: "OpenSSH bỏ qua khoá vì tài khoản khác đọc được. Chỉ để tài khoản của bạn đọc ~/.ssh/id_ed25519.",
    },
    unreachable: { label: "Không nối được", hint: "Kiểm tra mạng, VPN, địa chỉ và cổng." },
    no_ssh: {
      label: "Thiếu OpenSSH",
      hint: "Windows: Cài đặt → Hệ thống → Tính năng tuỳ chọn → thêm OpenSSH Client.",
    },
    error: { label: "Lỗi", hint: "Xem chi tiết bên dưới." },
  },
  en: {
    ok: { label: "Key works", hint: "Signs in with the key, no password." },
    auth: { label: "Needs setup", hint: "The server does not accept this machine's key yet." },
    hostkey_changed: {
      label: "Host key changed",
      hint: "Someone may be impersonating the server. Ask its admin before editing ~/.ssh/known_hosts.",
    },
    hostkey_unknown: {
      label: "Unknown server",
      hint: "The server is not in known_hosts. Install the key from the app to confirm its fingerprint.",
    },
    passphrase: { label: "Key needs passphrase", hint: "Load the key into ssh-agent (ssh-add), then check again." },
    key_perms: {
      label: "Bad key file permissions",
      hint: "OpenSSH skips the key because other accounts can read it. Only your account may read ~/.ssh/id_ed25519.",
    },
    unreachable: { label: "Unreachable", hint: "Check the network, VPN, address and port." },
    no_ssh: {
      label: "OpenSSH missing",
      hint: "Windows: Settings → System → Optional features → add OpenSSH Client.",
    },
    error: { label: "Error", hint: "See the details below." },
  },
};
