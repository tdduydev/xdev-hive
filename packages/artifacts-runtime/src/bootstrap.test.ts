import { describe, expect, it, vi } from "vitest";
import { BOOTSTRAP_SOURCE } from "./bootstrap.ts";
import { MAX_FRAME_TEXT, parseFrameMessage } from "./messages.ts";

type Handler = (event: Record<string, unknown>) => void;

/** Môi trường giả đủ cho bootstrap: không cần trình duyệt, chỉ cần thấy nó gửi gì lên `parent`. */
function run(readyState = "complete") {
  const posted: unknown[] = [];
  const listeners = new Map<string, Handler>();
  const originalWarn = vi.fn();
  const originalError = vi.fn();
  const fakeConsole = { error: originalError, warn: originalWarn, log: vi.fn() };
  const win: Record<string, unknown> = {
    parent: { postMessage: (message: unknown, target: string) => posted.push({ message, target }) },
    addEventListener: (type: string, handler: Handler) => listeners.set(type, handler),
  };
  // Mô phỏng origin mờ: đọc localStorage nguyên bản ném lỗi.
  Object.defineProperty(win, "localStorage", {
    get() {
      throw new Error("SecurityError");
    },
    configurable: true,
  });
  const observed: unknown[] = [];
  class FakeObserver {
    callback: () => void;
    constructor(callback: () => void) {
      this.callback = callback;
    }
    observe(target: unknown) {
      observed.push(target);
    }
  }
  const doc = {
    readyState,
    documentElement: { getBoundingClientRect: () => ({ height: 120.2 }) },
    body: {},
  };
  new Function("window", "document", "console", "requestAnimationFrame", "ResizeObserver", BOOTSTRAP_SOURCE)(
    win,
    doc,
    fakeConsole,
    (callback: () => void) => callback(),
    FakeObserver,
  );
  const messages = () => posted.map((p) => (p as { message: unknown }).message);
  return { win, listeners, messages, posted, fakeConsole, originalWarn, originalError, observed };
}

describe("BOOTSTRAP_SOURCE", () => {
  it("không chứa chuỗi làm thoát khỏi thẻ script", () => {
    expect(BOOTSTRAP_SOURCE).not.toMatch(/<\/script|<!--/i);
  });

  it("báo resize rồi ready khi trang đã nạp, mọi tin đúng schema", () => {
    const { messages, posted } = run();
    expect(messages()).toEqual([{ type: "resize", height: 121 }, { type: "ready" }]);
    expect(messages().every((m) => parseFrameMessage(m) !== null)).toBe(true);
    expect(posted.every((p) => (p as { target: string }).target === "*")).toBe(true);
  });

  it("chờ sự kiện load khi trang chưa nạp xong", () => {
    const { messages, listeners } = run("loading");
    expect(messages()).toEqual([]);
    listeners.get("load")?.({});
    expect(messages().at(-1)).toEqual({ type: "ready" });
  });

  it("theo dõi cả html và body để báo resize", () => {
    expect(run().observed).toHaveLength(2);
  });

  it("gửi tin console khi gọi console.error và console.warn, vẫn gọi hàm gốc", () => {
    const { fakeConsole, messages, originalError, originalWarn } = run();
    fakeConsole.error("lỗi", { a: 1 }, new TypeError("x"));
    fakeConsole.warn("cảnh báo");
    expect(messages().slice(-2)).toEqual([
      { type: "console", level: "error", message: 'lỗi {"a":1} TypeError: x' },
      { type: "console", level: "warn", message: "cảnh báo" },
    ]);
    expect(originalError).toHaveBeenCalledOnce();
    expect(originalWarn).toHaveBeenCalledWith("cảnh báo");
  });

  it("không gửi tin cho console.log", () => {
    const { fakeConsole, messages } = run();
    const before = messages().length;
    fakeConsole.log("im lặng");
    expect(messages()).toHaveLength(before);
  });

  it("gửi lỗi chạy và promise bị từ chối", () => {
    const { listeners, messages } = run();
    listeners.get("error")?.({ message: "Uncaught Error: boom", lineno: 7 });
    listeners.get("unhandledrejection")?.({ reason: new Error("rej") });
    listeners.get("unhandledrejection")?.({ reason: "chữ" });
    expect(messages().slice(-3)).toEqual([
      { type: "error", kind: "runtime", message: "Uncaught Error: boom (dòng 7)" },
      { type: "error", kind: "promise", message: "Error: rej" },
      { type: "error", kind: "promise", message: "chữ" },
    ]);
  });

  it("cắt chữ lỗi ở đúng ngưỡng của schema", () => {
    const { fakeConsole, messages } = run();
    fakeConsole.error("x".repeat(MAX_FRAME_TEXT * 3));
    const last = messages().at(-1) as { message: string };
    expect(last.message).toHaveLength(MAX_FRAME_TEXT);
    expect(parseFrameMessage(last)).not.toBeNull();
  });

  it("dừng gửi lỗi sau 200 tin nhưng vẫn gọi hàm gốc", () => {
    const { fakeConsole, messages, originalError } = run();
    for (let i = 0; i < 1000; i++) fakeConsole.error(`lỗi ${i}`);
    expect(messages().filter((m) => (m as { type: string }).type === "console")).toHaveLength(200);
    expect(originalError).toHaveBeenCalledTimes(1000);
  });

  it("thay localStorage và sessionStorage bằng bộ nhớ trong dùng được", () => {
    const { win } = run();
    for (const name of ["localStorage", "sessionStorage"]) {
      const storage = win[name] as Storage;
      expect(storage.getItem("a")).toBeNull();
      storage.setItem("a", "1");
      storage.setItem("b", 2 as unknown as string);
      expect(storage.getItem("a")).toBe("1");
      expect(storage.getItem("b")).toBe("2");
      expect(storage.length).toBe(2);
      expect(storage.key(0)).toBe("a");
      expect(storage.key(5)).toBeNull();
      storage.removeItem("a");
      expect(storage.length).toBe(1);
      storage.clear();
      expect(storage.length).toBe(0);
    }
  });

  it("không vỡ khi trang cha ném lỗi lúc postMessage", () => {
    const { listeners, win } = run();
    (win.parent as { postMessage: () => void }).postMessage = () => {
      throw new Error("detached");
    };
    expect(() => listeners.get("error")?.({ message: "x" })).not.toThrow();
  });
});
