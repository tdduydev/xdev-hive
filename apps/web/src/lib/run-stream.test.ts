import type { RunLogChunk } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import { LOG_LIMIT, LogBuffer, mergeEvents, runStreamUrl, stripAnsi } from "@/lib/run-stream.ts";

// Buffer của Node: chuỗi dài vượt giới hạn tham số của String.fromCharCode(...).
const b64 = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64");
let id = 0;
const chunk = (bytes: string, attempt = 1, b = b64(bytes)): RunLogChunk => ({
  id: ++id,
  attempt,
  offset: 0,
  bytes: b,
  createdAt: "2026-10-11T11:00:00.000Z",
});

describe("runStreamUrl", () => {
  it("tổ chức đi bằng tham số org", () =>
    expect(runStreamUrl("org-1", "run-1")).toBe("/api/v1/runs/run-1/stream?org=org-1"));
});

describe("mergeEvents", () => {
  const ev = (n: number) => ({ id: n, attempt: 1, seq: null, type: "state", data: {}, createdAt: "" });
  it("bỏ sự kiện đã có", () => {
    const merged = mergeEvents([ev(1), ev(2)], [ev(2), ev(3)]);
    expect(merged.map((e) => e.id)).toEqual([1, 2, 3]);
  });
  it("không có gì mới thì giữ nguyên mảng", () => {
    const current = [ev(1)];
    expect(mergeEvents(current, [ev(1)])).toBe(current);
  });
});

describe("stripAnsi", () => {
  it("bỏ mã màu và OSC", () => {
    const esc = String.fromCharCode(27);
    expect(stripAnsi(`${esc}[32m✓ đạt${esc}[0m ${esc}]0;title${String.fromCharCode(7)}xong`)).toBe("✓ đạt xong");
  });
});

describe("LogBuffer", () => {
  it("ghép ký tự UTF-8 bị cắt giữa hai đoạn", () => {
    const bytes = new TextEncoder().encode("hoá đơn");
    const buf = new LogBuffer();
    buf.append([chunk("", 1, b64(bytes.slice(0, 3))), chunk("", 1, b64(bytes.slice(3)))]);
    expect(buf.toString()).toBe("hoá đơn");
  });

  it("bỏ đoạn đã nhận, đổi \\r\\n, ngăn cách lần thử", () => {
    const buf = new LogBuffer();
    const first = chunk("a\r\nb\n");
    expect(buf.append([first])).toBe(true);
    expect(buf.append([first])).toBe(false);
    buf.append([chunk("c\n", 2)]);
    expect(buf.toString()).toBe("a\nb\n\n── Lần thử 2 ──\nc\n");
  });

  it("chỉ giữ phần cuối khi log quá dài", () => {
    const buf = new LogBuffer();
    buf.append([chunk("x".repeat(LOG_LIMIT + 10))]);
    expect(buf.toString().startsWith("… (đã bỏ phần log cũ")).toBe(true);
    expect(buf.toString().endsWith("x".repeat(100))).toBe(true);
  });
});
