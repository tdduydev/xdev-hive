// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deployStreamUrl, parseFrame, toLogChunk, useDeployStream } from "@/lib/use-deploy-stream.ts";

class FakeSource {
  static all: FakeSource[] = [];
  static readonly CLOSED = 2;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  readonly listeners = new Map<string, (e: MessageEvent<string>) => void>();
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSource.all.push(this);
  }
  addEventListener(name: string, fn: (e: MessageEvent<string>) => void) {
    this.listeners.set(name, fn);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  emit(name: string, data: unknown) {
    this.listeners.get(name)?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
}

// requestAnimationFrame giả để kiểm soát lúc hook đẩy log ra giao diện: nhiều đoạn log cùng nhịp chỉ ghi một lần.
const frames: Array<() => void> = [];
const runFrames = () =>
  act(() => {
    for (const fn of frames.splice(0)) fn();
  });

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

describe("deployStreamUrl", () => {
  it("tổ chức đi bằng tham số org", () =>
    expect(deployStreamUrl("org-1", "dep 1")).toBe("/api/v1/deploys/dep%201/stream?org=org-1"));
});

describe("parseFrame", () => {
  it("bỏ khung hỏng", () => {
    expect(parseFrame<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
    expect(parseFrame("{oops")).toBeNull();
  });
});

describe("toLogChunk", () => {
  it("điền attempt và offset cố định cho LogBuffer", () =>
    expect(toLogChunk({ id: 4, bytes: "aGk=", createdAt: "2026-10-20T00:00:00.000Z" })).toEqual({
      id: 4,
      attempt: 1,
      offset: 0,
      bytes: "aGk=",
      createdAt: "2026-10-20T00:00:00.000Z",
    }));
});

describe("useDeployStream", () => {
  beforeEach(() => {
    FakeSource.all = [];
    vi.stubGlobal("EventSource", FakeSource);
    frames.length = 0;
    vi.stubGlobal("requestAnimationFrame", (fn: () => void) => frames.push(fn));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frames[id - 1] = () => {};
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("ghép log, giữ trạng thái mới nhất và báo trang tải lại khi đổi", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useDeployStream("org-1", "dep-1", onChange));
    const source = FakeSource.all[0];
    if (!source) throw new Error("chưa mở luồng");
    expect(source.url).toBe("/api/v1/deploys/dep-1/stream?org=org-1");
    expect(result.current.status).toBe("connecting");

    act(() => source.onopen?.());
    expect(result.current.status).toBe("live");

    act(() => {
      source.emit("steps", { state: "running", steps: [] });
      source.emit("log", { id: 1, seq: 1, bytes: b64("bước 1\n"), createdAt: "2026-10-20T00:00:00.000Z" });
      // Hub phát lại đoạn cũ khi nối lại: không được ghi đôi.
      source.emit("log", { id: 1, seq: 1, bytes: b64("bước 1\n"), createdAt: "2026-10-20T00:00:00.000Z" });
      source.emit("log", { id: 2, seq: 2, bytes: b64("bước 2\n"), createdAt: "2026-10-20T00:00:01.000Z" });
    });
    expect(frames).toHaveLength(1);
    runFrames();
    expect(result.current.log).toBe("bước 1\nbước 2\n");
    expect(result.current.snapshot?.state).toBe("running");
    expect(onChange).toHaveBeenCalledTimes(1);

    act(() => source.emit("end", { state: "succeeded" }));
    expect(result.current.status).toBe("ended");
    expect(source.closed).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("hub trả lỗi thì hiện lỗi, bấm thử lại mở luồng mới từ đầu", () => {
    const { result } = renderHook(() => useDeployStream("org-1", "dep-1", () => {}));
    const first = FakeSource.all[0];
    if (!first) throw new Error("chưa mở luồng");
    act(() => {
      first.emit("log", { id: 1, seq: 1, bytes: b64("cũ\n"), createdAt: "2026-10-20T00:00:00.000Z" });
      first.readyState = FakeSource.CLOSED;
      first.onerror?.();
    });
    expect(result.current.status).toBe("error");

    act(() => result.current.retry());
    expect(FakeSource.all).toHaveLength(2);
    expect(result.current.log).toBe("");
    expect(result.current.status).toBe("connecting");
  });
});
