import { describe, expect, it } from "vitest";
import { type InstallEnv, installKind, isIos } from "@/lib/pwa.ts";

const env = (over: Partial<InstallEnv> = {}): InstallEnv => ({
  standalone: false,
  hasPrompt: false,
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/130",
  platform: "Linux x86_64",
  maxTouchPoints: 0,
  ...over,
});

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Safari/604.1";

describe("isIos", () => {
  it("nhận iPhone qua user agent", () => {
    expect(isIos(env({ userAgent: IPHONE, platform: "iPhone" }))).toBe(true);
  });
  it("nhận iPad đời mới tự xưng là Mac nhờ màn cảm ứng, không nhầm với Mac thật", () => {
    expect(isIos(env({ userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 5 }))).toBe(true);
    expect(isIos(env({ userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 0 }))).toBe(false);
  });
});

describe("installKind", () => {
  it("đã chạy như app thì không mời cài nữa", () => {
    expect(installKind(env({ standalone: true, hasPrompt: true }))).toBe("none");
    expect(installKind(env({ standalone: true, userAgent: IPHONE }))).toBe("none");
  });
  it("có sự kiện cài của trình duyệt thì dùng hộp cài", () => {
    expect(installKind(env({ hasPrompt: true }))).toBe("prompt");
  });
  it("iOS chưa cài thì chỉ có hướng dẫn", () => {
    expect(installKind(env({ userAgent: IPHONE, platform: "iPhone" }))).toBe("ios");
  });
  it("trình duyệt không hỗ trợ cài thì không hiện gì", () => {
    expect(installKind(env())).toBe("none");
  });
});
