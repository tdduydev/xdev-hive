import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider, type HiveClient } from "@xdev-hive/ui";
import "@xdev-hive/ui/globals.css";
import { DesktopApp } from "./DesktopApp.tsx";

declare global {
  interface Window {
    hive: HiveClient;
  }
}

// Errors outside rendering (an event handler, a promise nobody waited for) go to the same log as the crashes the
// interface catches: a blank window then has a trace (asked 2/10).
const logError = (text: string) => void window.hive.desktop?.logError?.(text).catch(() => undefined);
window.addEventListener("error", (e) => logError(`error: ${e.message} (${e.filename}:${e.lineno})`));
window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason as { stack?: string } | undefined;
  logError(`unhandledrejection: ${reason?.stack ?? String(e.reason)}`);
});

// The main process shows the tray, notifications and dialogs in the same language.
const setMainLocale = (locale: string) => void window.hive.desktop?.setLocale(locale).catch(() => undefined);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider onChange={setMainLocale}>
      <DesktopApp client={window.hive} />
    </I18nProvider>
  </StrictMode>,
);
