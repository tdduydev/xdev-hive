import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";
import { queryClient } from "@/lib/hub-query.tsx";

// Chunk Tiptap tải lười; máy CI tải nặng thì quá 1 giây mặc định của findBy*/waitFor.
configure({ asyncUtilTimeout: 10_000 });

// jsdom không dựng bố cục; ProseMirror (trình soạn Tiptap) đo vị trí con trỏ để cuộn và đặt menu.
const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= noRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
Element.prototype.getClientRects ??= noRects;
document.elementFromPoint ??= () => null;

afterEach(() => {
  cleanup();
  // Dữ liệu hub còn mới 30 giây (hub-query.tsx): không xoá thì test sau đọc lại dữ liệu giả của test trước.
  queryClient.clear();
  delete window.__TAURI__;
  localStorage.clear();
  location.hash = "";
});
