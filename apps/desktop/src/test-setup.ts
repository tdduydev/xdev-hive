import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
  delete window.__TAURI__;
  localStorage.clear();
  location.hash = "";
});
