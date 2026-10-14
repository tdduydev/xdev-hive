import { useEffect } from "react";
import { ConnectForm } from "@/components/connect-form.tsx";
import { LangToggle } from "@/components/lang-toggle.tsx";
import { Wordmark } from "@/components/logo.tsx";
import { type Dict, useT } from "@/lib/i18n.ts";
import { askNotificationPermission } from "@/lib/tauri.ts";

const text: Dict<{ title: string; lead: string; foot: string }> = {
  vi: {
    title: "Kết nối máy của bạn",
    lead: "Đăng ký một lần để worker nhận việc từ đội của bạn.",
    foot: "Đóng cửa sổ để ẩn vào khay. Worker vẫn chạy nền.",
  },
  en: {
    title: "Connect your machine",
    lead: "Register once so the worker can take tasks from your team.",
    foot: "Close the window to hide it in the tray. The worker keeps running.",
  },
};

/**
 * Cửa sổ đăng ký máy (AppRegister.dc.html). App không mở cửa sổ này khi khởi động nữa (app client dùng được khi chưa
 * kết nối); nó chỉ hiện khi người dùng bật worker từ khay mà máy chưa đăng ký, hoặc hub đòi đăng ký lại.
 */
export function RegisterScreen() {
  const t = useT(text);

  useEffect(() => {
    void askNotificationPermission();
  }, []);

  return (
    <main className="flex min-h-svh flex-col gap-[18px] bg-card p-7 text-card-foreground">
      <div className="flex items-center justify-between gap-3">
        <Wordmark />
        <LangToggle />
      </div>
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-[22px] font-semibold tracking-tight">{t.title}</h1>
        <p className="text-muted-foreground">{t.lead}</p>
      </div>
      <ConnectForm />
      <p className="mt-auto border-t pt-3 text-center text-xs text-muted-foreground">{t.foot}</p>
    </main>
  );
}
