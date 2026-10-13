import { useEffect, useState } from "react";
import { invoke } from "@/lib/tauri.ts";

/** Ngày giờ build theo giờ máy: 13/10/2026 14:05. */
export function formatBuiltAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface BuildInfo {
  /** Phiên bản app (tauri.conf.json, bản phát hành đặt theo tag); null ngoài Tauri. */
  version: string | null;
  sha: string;
  builtAt: string;
}

/** Phiên bản app lấy từ Tauri; mã commit và giờ build gắn lúc build giao diện. */
export function useBuildInfo(): BuildInfo {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    invoke<string>("plugin:app|version").then(setVersion, () => setVersion(null));
  }, []);
  return { version, sha: __BUILD_SHA__, builtAt: __BUILD_TIME__ };
}
