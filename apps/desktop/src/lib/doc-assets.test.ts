import type { DocResolvedLink } from "@xdev-hive/contracts";
import { describe, expect, it, vi } from "vitest";
import { createAssetResolver } from "@/lib/doc-assets.ts";

const ID = "0a0a0a0a-0000-4000-8000-00000000000a";
const KEY = "project/pay/architecture";

describe("createAssetResolver", () => {
  it("gom các ảnh cùng lượt vẽ vào một lời gọi và trả ảnh dạng data URL", async () => {
    const resolve = vi.fn(
      async (input: { docKey: string; hrefs: string[] }): Promise<DocResolvedLink[]> =>
        input.hrefs.map((href) =>
          href === "gone.png"
            ? { kind: "missing", href, reason: "Không có." }
            : {
                kind: "asset",
                href,
                assetId: ID,
                url: `/api/v1/docs/assets/${ID}?org=o&doc=${encodeURIComponent(KEY)}`,
              },
        ),
    );
    const fetchImage = vi.fn(async () => "data:image/png;base64,AAAA");
    const { resolveLink } = createAssetResolver(resolve, fetchImage);

    const [a, b, gone] = await Promise.all([
      resolveLink(KEY, "assets/a.png"),
      resolveLink(KEY, "assets/b.png"),
      resolveLink(KEY, "gone.png"),
    ]);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({ docKey: KEY, hrefs: ["assets/a.png", "assets/b.png", "gone.png"] });
    expect(a).toEqual({ kind: "asset", url: "data:image/png;base64,AAAA" });
    expect(b).toEqual(a);
    expect(gone).toBeNull();
  });

  it("nhớ kết quả của lần phân giải trước", async () => {
    const resolve = vi.fn(
      async (): Promise<DocResolvedLink[]> => [{ kind: "doc", href: "./khac.md", key: "project/pay/khac" }],
    );
    const { resolveLink } = createAssetResolver(resolve, async () => null);
    await resolveLink(KEY, "./khac.md");
    expect(await resolveLink(KEY, "./khac.md")).toEqual({ kind: "doc", key: "project/pay/khac" });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("tệp không phải ảnh thì không có đích, lỗi tải thì lần sau thử lại", async () => {
    const link = (href: string): DocResolvedLink => ({
      kind: "asset",
      href,
      assetId: ID,
      url: `/api/v1/docs/assets/${ID}`,
    });
    const resolve = vi.fn(async (input: { docKey: string; hrefs: string[] }) => input.hrefs.map(link));
    const fetchImage = vi
      .fn<(path: string) => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("mạng"));
    const { resolveLink } = createAssetResolver(resolve, fetchImage);

    expect(await resolveLink(KEY, "files/bao-cao.pdf")).toBeNull();
    await expect(resolveLink(KEY, "assets/a.png")).rejects.toThrow("mạng");
    fetchImage.mockResolvedValueOnce("data:image/png;base64,BBBB");
    expect(await resolveLink(KEY, "assets/a.png")).toEqual({ kind: "asset", url: "data:image/png;base64,BBBB" });
  });

  it("clear bỏ bộ nhớ đệm để ảnh vừa tải lên hiện được", async () => {
    const resolve = vi.fn(async (): Promise<DocResolvedLink[]> => []);
    const { resolveLink, clear } = createAssetResolver(resolve, async () => null);
    await resolveLink(KEY, "a.png");
    clear();
    await resolveLink(KEY, "a.png");
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
