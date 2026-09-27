import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HiveApp, I18nProvider, type HiveClient } from "@xdev-hive/ui";
import "@xdev-hive/ui/globals.css";

declare global {
  interface Window {
    hive: HiveClient;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <HiveApp client={window.hive} />
    </I18nProvider>
  </StrictMode>,
);
