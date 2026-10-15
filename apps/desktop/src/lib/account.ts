import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { queryClient } from "@/lib/hub-query.tsx";
import type { Profile } from "@/lib/nav.ts";
import { errorText, invoke } from "@/lib/tauri.ts";

/** Kiểu khớp với src-tauri/src/account.rs. Token không bao giờ đi về giao diện. */
export interface Account {
  name: string;
  email: string;
  orgId: string;
  orgName: string;
  orgRole: "owner" | "admin" | "member" | null;
  teams: { id: string; name: string; role: "admin" | "member" | "viewer" | "ba" }[];
}

export interface AccountStatus {
  hub: string | null;
  linked: boolean;
  account: Account | null;
  error: string | null;
}

export const accountStatus = () => invoke<AccountStatus>("account_status");
export const linkAccount = (token: string) => invoke<AccountStatus>("account_link", { token });
export const unlinkAccount = () => invoke<AccountStatus>("account_unlink");

/**
 * Hồ sơ menu từ vai trò thật (specs/008-desktop-v2): lead = owner/admin tổ chức hoặc admin một đội; writer = chỉ là
 * người xem hoặc BA/PO ở mọi đội mình thuộc; còn lại là dev. Chưa liên kết tài khoản thì dev, như trước khi có danh tính.
 */
export function profileOf(account: Account | null): Profile {
  if (!account) return "dev";
  if (account.orgRole === "owner" || account.orgRole === "admin") return "lead";
  if (account.teams.some((t) => t.role === "admin")) return "lead";
  if (account.teams.length > 0 && account.teams.every((t) => t.role === "viewer" || t.role === "ba")) return "writer";
  return "dev";
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "";
  return (first + last).toUpperCase() || "?";
}

/** Trạng thái tài khoản của app, đọc một lần khi mở và sau mỗi lần liên kết hoặc gỡ. */
export function useAccount() {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setStatus(await accountStatus());
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // Đăng xuất từ khay không đi qua cửa sổ này: Rust báo để menu và các màn hub không còn coi là đã đăng nhập.
  useEffect(() => {
    const tauri = window.__TAURI__;
    if (!tauri?.event) return;
    let stop: (() => void) | null = null;
    let gone = false;
    void tauri.event
      .listen("account-changed", () => {
        queryClient.clear();
        void refresh();
      })
      .then((un) => {
        if (gone) un();
        else stop = un;
      })
      .catch(() => {});
    return () => {
      gone = true;
      stop?.();
    };
  }, [refresh]);
  return { status, error, refresh, setStatus };
}

/** Tài khoản đã liên kết cho các màn trong bảng SCREENS (màn không nhận props). AppShell cấp giá trị. */
export const AccountContext = createContext<Account | null>(null);
export const useLinkedAccount = () => useContext(AccountContext);

/**
 * Mở hộp thoại kết nối Hive từ bất kỳ màn nào (AppShell cấp). Null khi màn chạy ngoài AppShell (test riêng màn): nút
 * Kết nối ẩn đi thay vì bấm không có tác dụng.
 */
export const ConnectContext = createContext<(() => void) | null>(null);
export const useConnect = () => useContext(ConnectContext);
