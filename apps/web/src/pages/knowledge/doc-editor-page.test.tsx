// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createAssetResolver } from "@/pages/knowledge/doc-editor-page.tsx";

describe("phân giải đính kèm", () => {
  it("gom link của một tài liệu, giữ cache và không dùng link gãy", async () => {
    const resolve = vi.fn(async ({ hrefs }: { docKey: string; hrefs: string[] }) =>
      hrefs.map((href) =>
        href === "missing.png"
          ? { kind: "missing" as const, href, reason: "Không tìm thấy file." }
          : { kind: "asset" as const, href, assetId: "a", url: `/api/assets/${href}` },
      ),
    );
    const resolver = createAssetResolver(resolve);
    const first = resolver.resolveLink("org/a", "a.png");
    const second = resolver.resolveLink("org/a", "b.pdf");
    const missing = resolver.resolveLink("org/a", "missing.png");
    expect(await first).toMatchObject({ kind: "asset", url: "/api/assets/a.png" });
    await second;
    expect(await missing).toBeNull();
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve.mock.calls[0]?.[0].hrefs).toEqual(["a.png", "b.pdf", "missing.png"]);
    expect(resolver.resolveLink("org/a", "a.png")).toBe(first);
    resolver.clear();
    await resolver.resolveLink("org/a", "a.png");
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("không dùng cache của tài liệu khác và cho thử lại sau lỗi", async () => {
    const resolve = vi.fn().mockRejectedValueOnce(new Error("Mất mạng")).mockResolvedValue([]);
    const resolver = createAssetResolver(resolve);
    await expect(resolver.resolveLink("org/a", "same.png")).rejects.toThrow("Mất mạng");
    const one = resolver.resolveLink("org/a", "same.png");
    const two = resolver.resolveLink("org/b", "same.png");
    await Promise.all([one, two]);
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(resolve.mock.calls.slice(1).map(([input]) => input.docKey)).toEqual(["org/a", "org/b"]);
  });
});
