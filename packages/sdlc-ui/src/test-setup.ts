import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// findBy*/waitFor mặc định chỉ chờ 1 giây; các tab nạp lazy (bản tách, ma trận) phải nạp module lần đầu, lúc CI hoặc
// máy dev đang bận thì vượt ngưỡng đó dù component vẫn đúng. Mốc 10 giây nằm dưới testTimeout (20 giây).
configure({ asyncUtilTimeout: 10_000 });

afterEach(cleanup);

// jsdom không có ResizeObserver; `@xyflow/react` cần nó để đo khung đồ thị.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
