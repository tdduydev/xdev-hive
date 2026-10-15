import { describe, expect, it } from "vitest";
import { lfsDownload, lfsUpload } from "./lfs.ts";

describe("Git LFS transfer actions", () => {
  it("uploads and downloads bytes using the action URL and headers", async () => {
    const calls: Request[] = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(new Request(input, init));
      return new Response(new Uint8Array([1, 2, 3]));
    };
    const action = { href: "https://objects.example.test/item", header: { authorization: "signed" } };
    await lfsUpload(action, new Uint8Array([1, 2, 3]), fetcher);
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.headers.get("authorization")).toBe("signed");
    expect([...(await lfsDownload(action, fetcher))]).toEqual([1, 2, 3]);
  });
});
