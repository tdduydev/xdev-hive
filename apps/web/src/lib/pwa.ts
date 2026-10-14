import { useSyncExternalStore } from "react";

/**
 * PWA: đăng ký service worker (chỉ bản build) và theo dõi khả năng "Cài lên màn hình chính".
 * Chrome/Edge/Android báo qua `beforeinstallprompt`; Safari iOS không có sự kiện này, chỉ cài được bằng Chia sẻ → Thêm
 * vào MH chính, nên giao diện hiện hướng dẫn riêng.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** `none`: không có gì để cài (đã cài, hoặc trình duyệt không hỗ trợ). `prompt`: hộp cài của trình duyệt. `ios`: chỉ hướng dẫn. */
export type InstallKind = "none" | "prompt" | "ios";

export interface InstallEnv {
  standalone: boolean;
  hasPrompt: boolean;
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
}

/** iPadOS 13+ tự nhận là Mac trong user agent, chỉ phân biệt được qua màn cảm ứng. */
export function isIos(env: Pick<InstallEnv, "userAgent" | "platform" | "maxTouchPoints">): boolean {
  return /iPhone|iPad|iPod/.test(env.userAgent) || (env.platform === "MacIntel" && env.maxTouchPoints > 1);
}

export function installKind(env: InstallEnv): InstallKind {
  if (env.standalone) return "none";
  if (env.hasPrompt) return "prompt";
  return isIos(env) ? "ios" : "none";
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

function readEnv(): InstallEnv {
  return {
    standalone:
      matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true,
    hasPrompt: deferred !== null,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
  };
}

/** Gọi sớm ở main.tsx: `beforeinstallprompt` bắn một lần lúc tải trang, có thể trước khi nút được vẽ. */
export function startPwa(): void {
  window.addEventListener("beforeinstallprompt", (event) => {
    // Giữ lại để cài khi người dùng bấm nút, thay vì để thanh nhỏ mặc định của trình duyệt tự bật.
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    emit();
  });
  // Dev không đăng ký: service worker giữ file cũ làm khó việc sửa code, và test e2e không cần.
  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    // Chờ `load` để việc tải vỏ về cache không tranh mạng với lần mở trang đầu.
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
        /* Không đăng ký được (HTTP không an toàn, chế độ riêng tư): app vẫn chạy, chỉ không cài được. */
      });
    });
  }
}

export async function promptInstall(): Promise<void> {
  const event = deferred;
  if (!event) return;
  // Mỗi sự kiện chỉ gọi `prompt()` được một lần.
  deferred = null;
  emit();
  await event.prompt();
  await event.userChoice;
}

// Snapshot phải ổn định giữa các lần gọi khi trạng thái không đổi: trả chuỗi, không trả object mới.
const snapshot = (): InstallKind => installKind(readEnv());

export function useInstallKind(): InstallKind {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot,
    () => "none",
  );
}
