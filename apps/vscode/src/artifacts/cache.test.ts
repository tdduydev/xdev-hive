import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ArtifactCache, sha256 } from "@/artifacts/cache.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function setup(limit?: number) {
  const dir = await mkdtemp(join(tmpdir(), "hive-artifacts-"));
  dirs.push(dir);
  return new ArtifactCache(join(dir, "cache"), limit);
}
it("kiểm sha256, phát hiện bộ đệm hỏng và tách tài khoản", async () => {
  const cache = await setup();
  await cache.put("account-a:id:1", "document");
  expect(await cache.get("account-a:id:1")).toBe("document");
  expect(await cache.get("account-b:id:1")).toBeNull();
  await writeFile(
    join(cache.root, sha256("account-a:id:1")),
    JSON.stringify({ value: "tampered", digest: sha256("document") }),
  );
  expect(await cache.get("account-a:id:1")).toBeNull();
});
it("LRU loại bản cũ, giữ bản vừa mở và bỏ bản quá lớn", async () => {
  const cache = await setup(300);
  await cache.put("one", "a".repeat(30));
  await cache.put("two", "b".repeat(30));
  await cache.get("one");
  await cache.put("three", "c".repeat(30));
  expect(await cache.get("one")).not.toBeNull();
  expect(await cache.get("two")).toBeNull();
  await cache.put("large", "x".repeat(301));
  expect(await cache.get("large")).toBeNull();
});
it("xoá đứng sau mọi lần ghi đang chờ khi đăng xuất", async () => {
  const cache = await setup();
  await Promise.all([cache.put("one", "private"), cache.put("two", "private"), cache.clear()]);
  expect(await cache.get("one")).toBeNull();
  expect(await readdir(cache.root).catch(() => [])).toEqual([]);
});
