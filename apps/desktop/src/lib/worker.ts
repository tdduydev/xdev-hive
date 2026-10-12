import { useEffect, useState } from "react";
import { onWorkerState, type WorkerKind, type WorkerView, workerState } from "@/lib/tauri.ts";

/** Màu chấm theo trạng thái, cùng quy ước với chấm trên biểu tượng khay (src-tauri/src/tray_icon.rs). */
export const WORKER_DOT: Record<WorkerKind, string> = {
  stopped: "bg-muted-foreground",
  starting: "bg-warning",
  connecting: "bg-warning",
  stopping: "bg-warning",
  online: "bg-success",
  disconnected: "bg-destructive",
  failed: "bg-destructive",
};

/** "Worker: đang nhận việc" của khay thành "Worker đang nhận việc" cho thẻ ở AppNav (AppNav.dc.html). */
export const workerSentence = (label: string) => label.replace(/^Worker:\s*/, "Worker ");

/** Trạng thái worker: đọc một lần rồi cập nhật theo sự kiện "worker-state" của Rust. */
export function useWorkerState(): WorkerView | null {
  const [view, setView] = useState<WorkerView | null>(null);
  useEffect(() => {
    let alive = true;
    workerState().then(
      (v) => alive && setView(v),
      () => {},
    );
    const stop = onWorkerState((v) => alive && setView(v));
    return () => {
      alive = false;
      stop();
    };
  }, []);
  return view;
}
