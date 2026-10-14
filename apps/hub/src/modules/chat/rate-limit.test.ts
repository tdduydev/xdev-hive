import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limit.ts";

describe("RateLimiter", () => {
  it("cho tối đa N lần trong cửa sổ rồi từ chối, và mở lại khi cửa sổ trượt qua", () => {
    let now = 0;
    const limiter = new RateLimiter(3, 1000, () => now);
    expect([1, 2, 3].map(() => limiter.allow("a"))).toEqual([true, true, true]);
    expect(limiter.allow("a")).toBe(false);
    now = 999;
    expect(limiter.allow("a")).toBe(false);
    now = 1001;
    expect(limiter.allow("a")).toBe(true);
  });

  it("đếm riêng từng khoá", () => {
    const limiter = new RateLimiter(1, 1000, () => 0);
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("b")).toBe(true);
    expect(limiter.allow("a")).toBe(false);
  });

  it("lần bị từ chối không kéo dài thời gian khoá", () => {
    let now = 0;
    const limiter = new RateLimiter(1, 1000, () => now);
    limiter.allow("a");
    now = 500;
    limiter.allow("a");
    now = 1001;
    expect(limiter.allow("a")).toBe(true);
  });
});
