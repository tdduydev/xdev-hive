import { cleanup, configure } from "@testing-library/react";
import { afterEach, expect, vi } from "vitest";
import { queryClient } from "@/lib/hub-query.tsx";

// Chunk Tiptap tải lười; máy CI tải nặng thì quá 1 giây mặc định của findBy*/waitFor.
configure({ asyncUtilTimeout: 10_000 });

// jsdom không dựng bố cục; ProseMirror (trình soạn Tiptap) đo vị trí con trỏ để cuộn và đặt menu.
const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= noRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
Element.prototype.getClientRects ??= noRects;
document.elementFromPoint ??= () => null;

// Base UI chỉ in cảnh báo dùng sai (vd. Button render <a> mà thiếu nativeButton={false}) ra console, mỗi loại một lần:
// test xanh nhưng log CI đầy cảnh báo và lỗi a11y lọt qua. Biến cảnh báo đó thành test hỏng.
const baseUiErrors: string[] = [];
const consoleError = console.error;
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].startsWith("Base UI:")) baseUiErrors.push(args[0]);
  consoleError(...args);
};

afterEach(async () => {
  cleanup();
  const misuse = baseUiErrors.splice(0);
  if (misuse.length) throw new Error(`Base UI cảnh báo dùng sai component:\n${misuse.join("\n")}`);
  // Lời gọi hub còn bay (mutation vừa gửi, refetch sau invalidate) mà về sau clear() sẽ ghi dữ liệu của test này vào
  // cache của test kế: dữ liệu còn mới 30 giây nên test kế không gọi lại mà dùng luôn bản lạc đó. Chờ chúng xong trước.
  // Test cố ý treo lời gọi (kiểm trạng thái đang tải) thì hết hạn chờ, vẫn xoá.
  await vi
    .waitFor(() => expect(queryClient.isFetching() + queryClient.isMutating()).toBe(0), { timeout: 3000 })
    .catch(() => {});
  // Dữ liệu hub còn mới 30 giây (hub-query.tsx): không xoá thì test sau đọc lại dữ liệu giả của test trước.
  queryClient.clear();
  delete window.__TAURI__;
  localStorage.clear();
  location.hash = "";
});
