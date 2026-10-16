import { useEffect, useState } from "react";
import { invoke, onTauriEvent } from "@/lib/tauri.ts";

/** Bản đã tải xong, chờ mở lại để cài (ReadyView trong src-tauri/src/updates.rs). */
export interface ReadyUpdate {
  version: string;
  notes: string | null;
}
export interface UpdateStatus {
  current: string;
  ready: ReadyUpdate | null;
}

export const updateStatus = () => invoke<UpdateStatus>("update_status");
/** Kiểm ngay trên máy chủ phát hành; có bản mới thì Rust tải về và báo "update-ready". */
export const checkUpdatesNow = () => invoke<UpdateStatus>("check_updates_now");
/** Dừng worker êm, cài bản đã tải rồi mở lại app. Thành công thì cửa sổ đóng nên lời hứa này không trả về. */
export const relaunchToUpdate = () => invoke<void>("relaunch_to_update");

/** Bản đã sẵn sàng: đọc một lần lúc mở cửa sổ, rồi theo sự kiện "update-ready" của Rust. */
export function useReadyUpdate(): ReadyUpdate | null {
  const [ready, setReady] = useState<ReadyUpdate | null>(null);
  useEffect(() => {
    let alive = true;
    updateStatus().then(
      (s) => alive && s?.ready && setReady(s.ready),
      () => {},
    );
    const stop = onTauriEvent<ReadyUpdate>("update-ready", (u) => alive && setReady(u));
    return () => {
      alive = false;
      stop();
    };
  }, []);
  return ready;
}
