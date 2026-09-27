import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HiveApp, type HiveClient } from "@xdev-hive/ui";
import "@xdev-hive/ui/globals.css";

declare global {
  interface Window {
    hive: HiveClient;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HiveApp client={window.hive} />
  </StrictMode>,
);
