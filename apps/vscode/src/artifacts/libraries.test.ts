import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadLibraries, verifyCachedLibraries } from "@/artifacts/libraries.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const data = "export const library = 1;";
function manifest(path = "react@1/index.js") {
  return {
    react: {
      path,
      kind: "module",
      bytes: Buffer.byteLength(data),
      integrity: `sha384-${createHash("sha384").update(data).digest("base64")}`,
    },
  };
}
async function root() {
  const dir = await mkdtemp(join(tmpdir(), "hive-artifact-lib-"));
  roots.push(dir);
  return dir;
}
it("tải thư viện không kèm token, tái dùng bản kiểm SRI và kiểm lại khi offline", async () => {
  const transport = vi.fn(async (url: URL, options: RequestInit) => {
    expect(options).not.toHaveProperty("headers");
    expect(options.redirect).toBe("error");
    return new Response(url.pathname.endsWith("lib-manifest.json") ? JSON.stringify(manifest()) : data);
  });
  vi.stubGlobal("fetch", transport);
  const dir = await root();
  const cached = await loadLibraries(dir, "http://hub.test");
  expect(await readFile(join(cached, "react@1/index.js"), "utf8")).toBe(data);
  await loadLibraries(dir, "http://hub.test");
  expect(transport).toHaveBeenCalledTimes(3);
  await expect(verifyCachedLibraries(cached)).resolves.toBeUndefined();
  await writeFile(join(cached, "react@1/index.js"), "corrupted");
  await expect(verifyCachedLibraries(cached)).rejects.toThrow("không hợp lệ");
});
it("từ chối thư viện hỏng hoặc tải vượt số byte manifest", async () => {
  for (const body of ["X".repeat(data.length), data.repeat(2)]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: URL) =>
          new Response(url.pathname.endsWith("lib-manifest.json") ? JSON.stringify(manifest()) : body),
      ),
    );
    await expect(loadLibraries(await root(), "https://hub.test")).rejects.toThrow();
  }
});
it("không tải đường dẫn traversal từ manifest", async () => {
  const transport = vi.fn(async () => new Response(JSON.stringify(manifest("../../outside"))));
  vi.stubGlobal("fetch", transport);
  await expect(loadLibraries(await root(), "https://hub.test")).rejects.toThrow("Đường dẫn");
  expect(transport).toHaveBeenCalledTimes(1);
});
