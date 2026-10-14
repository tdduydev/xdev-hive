import { describe, expect, it } from "vitest";
import {
  applyModifiers,
  composeLine,
  controlCode,
  encodeKey,
  KEY_NAMES,
  type KeyName,
  type Modifiers,
  NO_MODIFIERS,
} from "@/lib/terminal/keys.ts";

const mods = (over: Partial<Modifiers>): Modifiers => ({ ...NO_MODIFIERS, ...over });

describe("encodeKey", () => {
  it("phím đơn", () => {
    expect(encodeKey("esc")).toBe("\x1b");
    expect(encodeKey("tab")).toBe("\t");
    expect(encodeKey("enter")).toBe("\r");
    expect(encodeKey("slash")).toBe("/");
    expect(encodeKey("ctrl-c")).toBe("\x03");
    expect(encodeKey("ctrl-d")).toBe("\x04");
  });
  it("mũi tên theo chuỗi CSI của xterm", () => {
    expect(encodeKey("up")).toBe("\x1b[A");
    expect(encodeKey("down")).toBe("\x1b[B");
    expect(encodeKey("right")).toBe("\x1b[C");
    expect(encodeKey("left")).toBe("\x1b[D");
  });
  it("mũi tên có Ctrl/Alt mang mã modifier", () => {
    expect(encodeKey("left", mods({ ctrl: true }))).toBe("\x1b[1;5D");
    expect(encodeKey("right", mods({ alt: true }))).toBe("\x1b[1;3C");
    expect(encodeKey("up", mods({ ctrl: true, alt: true }))).toBe("\x1b[1;7A");
  });
  it("Alt thêm tiền tố ESC", () => {
    expect(encodeKey("enter", mods({ alt: true }))).toBe("\x1b\r");
    expect(encodeKey("tab", mods({ alt: true }))).toBe("\x1b\t");
  });
  it("Ctrl + / là 0x1f; Ctrl-C giữ nguyên", () => {
    expect(encodeKey("slash", mods({ ctrl: true }))).toBe("\x1f");
    expect(encodeKey("ctrl-c", mods({ ctrl: true }))).toBe("\x03");
  });
  it("mọi phím trong bảng đều có chuỗi không rỗng", () => {
    for (const key of KEY_NAMES) expect(encodeKey(key as KeyName).length).toBeGreaterThan(0);
  });
});

describe("controlCode", () => {
  it("chữ cái → 1..26, không phân biệt hoa thường", () => {
    expect(controlCode("a")).toBe("\x01");
    expect(controlCode("C")).toBe("\x03");
    expect(controlCode("z")).toBe("\x1a");
  });
  it("ký tự đặc biệt", () => {
    expect(controlCode("[")).toBe("\x1b");
    expect(controlCode(" ")).toBe("\x00");
    expect(controlCode("?")).toBe("\x7f");
    expect(controlCode("/")).toBe("\x1f");
  });
  it("không có mã cho chữ có dấu, số, hay chuỗi dài", () => {
    expect(controlCode("ế")).toBeNull();
    expect(controlCode("1")).toBeNull();
    expect(controlCode("ab")).toBeNull();
  });
});

describe("applyModifiers", () => {
  it("không giữ phím nào thì giữ nguyên", () => {
    expect(applyModifiers("c", NO_MODIFIERS)).toBe("c");
  });
  it("Ctrl + chữ vừa gõ thành mã điều khiển", () => {
    expect(applyModifiers("c", mods({ ctrl: true }))).toBe("\x03");
    expect(applyModifiers("R", mods({ ctrl: true }))).toBe("\x12");
  });
  it("Alt + chữ thành ESC + chữ; Ctrl + Alt kết hợp", () => {
    expect(applyModifiers("f", mods({ alt: true }))).toBe("\x1bf");
    expect(applyModifiers("b", mods({ ctrl: true, alt: true }))).toBe("\x1b\x02");
  });
  it("chuỗi dài hay chuỗi phím đặc biệt không bị đổi", () => {
    expect(applyModifiers("xin chào", mods({ ctrl: true }))).toBe("xin chào");
    expect(applyModifiers("\x1b[A", mods({ ctrl: true }))).toBe("\x1b[A");
  });
  it("chữ không có mã điều khiển vẫn tới CLI, không bị nuốt", () => {
    expect(applyModifiers("ế", mods({ ctrl: true }))).toBe("ế");
  });
});

describe("composeLine", () => {
  it("giữ nguyên chữ Việt có dấu và tách Enter riêng", () => {
    expect(composeLine("xin chào")).toEqual({ text: "xin chào", submit: "\r" });
  });
  it("xuống dòng trong ô soạn (dán nhiều dòng) không thành phím Enter giữa chừng", () => {
    expect(composeLine("a\r\nb\nc").text).toBe("a b c");
  });
  it("dòng rỗng vẫn gửi được Enter", () => {
    expect(composeLine("")).toEqual({ text: "", submit: "\r" });
  });
});
