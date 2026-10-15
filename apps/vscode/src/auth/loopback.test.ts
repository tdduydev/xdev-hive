import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listen } from "@/auth/loopback.ts";
import { pkce } from "@/auth/pkce.ts";

afterEach(() => vi.useRealTimers());

describe("PKCE và callback loopback", () => {
  it("sinh đủ entropy và challenge S256", () => {
    const a = pkce();
    const b = pkce();
    expect(Buffer.from(a.verifier, "base64url")).toHaveLength(32);
    expect(Buffer.from(a.state, "base64url")).toHaveLength(16);
    expect(a.state).not.toBe(b.state);
    expect(a.challenge).toBe(createHash("sha256").update(a.verifier).digest("base64url"));
  });

  it("từ chối state sai, POST và đường dẫn lạ; chỉ đổi mã callback đúng", async () => {
    const callback = await listen("expected");
    try {
      const url = `http://127.0.0.1:${callback.port}`;
      expect((await fetch(`${url}/callback?state=wrong&code=bad`)).status).toBe(400);
      expect((await fetch(`${url}/callback?state=expected&code=bad`, { method: "POST" })).status).toBe(404);
      expect((await fetch(`${url}/other`)).status).toBe(404);
      expect((await fetch(`${url}/callback?state=expected&code=good`)).status).toBe(200);
      expect(await callback.code).toBe("good");
      await expect(fetch(`${url}/callback?state=expected&code=replay`)).rejects.toThrow();
    } finally {
      callback.dispose();
    }
  });

  it("hết hạn đúng 5 phút và đóng cổng", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const callback = await listen("expected");
    const rejected = expect(callback.code).rejects.toThrow("5 phút");
    await vi.advanceTimersByTimeAsync(299_999);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    vi.useRealTimers();
    await expect(fetch(`http://127.0.0.1:${callback.port}/callback`)).rejects.toThrow();
  });

  it("từ chối trên hub hoặc dispose đều giải phóng callback", async () => {
    const callback = await listen("expected");
    await fetch(`http://127.0.0.1:${callback.port}/callback?state=expected&error=denied`);
    await expect(callback.code).rejects.toThrow("huỷ");
    const cancelled = await listen("expected");
    cancelled.dispose();
    await expect(cancelled.code).rejects.toThrow("huỷ");
  });
});
