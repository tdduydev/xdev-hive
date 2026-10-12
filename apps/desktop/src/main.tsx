import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { getLang, subscribeLang } from "@/lib/i18n.ts";
import { syncTrayLang, windowKind } from "@/lib/tauri.ts";
import { applyTheme, readTheme, watchSystemTheme } from "@/lib/theme.ts";
import { RegisterScreen } from "@/screens/register-screen.tsx";
import { AppShell } from "@/shell/app-shell.tsx";
import "@/styles.css";

// CSP của app (tauri.conf.json) không cho script inline, nên đặt sáng/tối ở đây, trước lần vẽ đầu.
applyTheme(readTheme());
watchSystemTheme();
// Khay hệ thống theo ngôn ngữ của giao diện, cả lúc mở lẫn khi người dùng đổi VI/EN.
syncTrayLang(getLang());
subscribeLang(() => syncTrayLang(getLang()));

const root = document.getElementById("root");
if (!root) throw new Error("Thiếu #root");
createRoot(root).render(<StrictMode>{windowKind() === "app" ? <AppShell /> : <RegisterScreen />}</StrictMode>);
