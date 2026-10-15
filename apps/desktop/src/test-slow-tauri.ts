import { beforeEach } from "vitest";

// Mỗi test dựng cầu nối Tauri giả trả lời ngay trong microtask, nên test nào khẳng định đồng bộ khi dữ liệu còn đang tải
// hay bấm nút đang bị khoá vẫn xanh, chỉ hỏng ở CI lúc máy bận. Đặt HIVE_TEST_TAURI_DELAY_MS=300 (`pnpm test:slow`) để
// mọi lệnh trả lời trễ ngẫu nhiên tới chừng đó mili giây: test như vậy hỏng ngay trên máy dev. Không đặt thì không làm gì.
const maxDelay = Number(process.env.HIVE_TEST_TAURI_DELAY_MS ?? 0);

if (maxDelay > 0) {
  // test-setup.ts xoá `window.__TAURI__` sau mỗi test và test gán lại cầu nối mới, nên phải gắn lại bộ chặn trước mỗi test.
  beforeEach(() => {
    let bridge: Window["__TAURI__"];
    Object.defineProperty(window, "__TAURI__", {
      configurable: true,
      get: () => bridge,
      set: (next: Window["__TAURI__"]) => {
        if (next) {
          const invoke = next.core.invoke;
          // Gọi handler ngay (test đọc `calls` đồng bộ) và chỉ trễ phần trả lời.
          const slow = <T>(command: string, args?: Record<string, unknown>) => {
            const reply = invoke<T>(command, args);
            reply.catch(() => {});
            return new Promise<T>((resolve, reject) =>
              setTimeout(() => reply.then(resolve, reject), Math.random() * maxDelay),
            );
          };
          next = { ...next, core: { ...next.core, invoke: slow } };
        }
        bridge = next;
      },
    });
  });
}
