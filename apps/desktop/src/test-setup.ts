import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { queryClient } from "@/lib/hub-query.tsx";

afterEach(() => {
  cleanup();
  // Dữ liệu hub còn mới 30 giây (hub-query.tsx): không xoá thì test sau đọc lại dữ liệu giả của test trước.
  queryClient.clear();
  delete window.__TAURI__;
  localStorage.clear();
  location.hash = "";
});
