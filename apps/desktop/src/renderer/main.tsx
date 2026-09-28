import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HiveApp, I18nProvider, type HiveClient } from "@xdev-hive/ui";
import "@xdev-hive/ui/globals.css";

declare global {
  interface Window {
    hive: HiveClient;
  }
}

// The main process shows the tray, notifications and dialogs in the same language.
const setMainLocale = (locale: string) => void window.hive.desktop?.setLocale(locale).catch(() => undefined);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider onChange={setMainLocale}>
      <HiveApp client={window.hive} />
    </I18nProvider>
  </StrictMode>,
);
