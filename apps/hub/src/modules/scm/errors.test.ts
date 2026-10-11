import { describe, expect, it } from "vitest";
import { errorFromResponse, GitProviderError, isGitProviderError, parseRetryAfter } from "./errors.ts";

const now = Date.parse("2026-10-11T00:00:00Z");

describe("parseRetryAfter", () => {
  it("số giây", () => expect(parseRetryAfter("120", now)).toBe(120_000));
  it("ngày HTTP", () => expect(parseRetryAfter("Sun, 11 Oct 2026 00:00:30 GMT", now)).toBe(30_000));
  it("ngày đã qua thì 0", () => expect(parseRetryAfter("Sat, 10 Oct 2026 00:00:00 GMT", now)).toBe(0));
  it("thiếu hoặc sai thì null", () => {
    expect(parseRetryAfter(undefined, now)).toBeNull();
    expect(parseRetryAfter("sớm thôi", now)).toBeNull();
  });
});

describe("errorFromResponse", () => {
  it("chỉ gắn retryAfterMs khi bị giới hạn", () => {
    const e = errorFromResponse("gitlab", 503, { "retry-after": "5" }, undefined, now);
    expect(e.code).toBe("unavailable");
    expect(e.retryAfterMs).toBeNull();
  });

  it("thông báo tiếng Việt kèm chi tiết của nhà cung cấp", () => {
    const e = errorFromResponse("github", 404, {}, "Not Found", now);
    expect(e.message).toBe("GitHub: không tìm thấy (Not Found)");
  });

  it("isGitProviderError lọc theo mã", () => {
    const e = new GitProviderError("conflict", "x");
    expect(isGitProviderError(e)).toBe(true);
    expect(isGitProviderError(e, "conflict")).toBe(true);
    expect(isGitProviderError(e, "not_found")).toBe(false);
    expect(isGitProviderError(new Error("x"))).toBe(false);
  });
});
