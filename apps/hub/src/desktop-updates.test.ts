import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.ts";
import { DesktopReleaseCache, findDesktopUpdate, newerVersion } from "./modules/system/index.ts";

let directory = "";
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = "";
});
const manifest = {
  version: "2.0.0-rc.2",
  notes: "Ghi chú",
  pub_date: "2026-10-11T00:00:00Z",
  platforms: { "darwin-aarch64": { url: "https://example.com/app", signature: "sig" } },
};

describe("desktop updates", () => {
  it("so sánh semver kể cả pre-release", () => {
    expect(newerVersion("2.0.0-rc.2", "2.0.0-rc.1")).toBe(true);
    expect(newerVersion("2.0.0", "2.0.0-rc.9")).toBe(true);
    expect(newerVersion("2.0.0-rc.1", "2.0.0")).toBe(false);
    expect(newerVersion("1.9.9", "2.0.0-rc.1")).toBe(false);
  });
  it("đọc lại manifest sau tối đa năm phút", async () => {
    directory = await mkdtemp(join(tmpdir(), "hive-release-"));
    const file = join(directory, "release.json");
    await writeFile(file, JSON.stringify(manifest));
    let now = 10_000;
    const cache = new DesktopReleaseCache(file, () => now);
    expect((await cache.get())?.version).toBe(manifest.version);
    await writeFile(file, JSON.stringify({ ...manifest, version: "2.0.0" }));
    now += 299_999;
    expect((await cache.get())?.version).toBe(manifest.version);
    now++;
    expect((await cache.get())?.version).toBe("2.0.0");
  });
  it("trả 200, 204 và 400 đúng trường hợp", async () => {
    directory = await mkdtemp(join(tmpdir(), "hive-release-"));
    const file = join(directory, "release.json");
    await writeFile(file, JSON.stringify(manifest));
    const app = createApp({ config: { port: 0, version: "test", desktopReleases: file } });
    const base = "/api/v1/desktop/updates/macos/aarch64/2.0.0-rc.1";
    const update = await app.request(base);
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({ version: manifest.version, signature: "sig" });
    expect((await app.request(base.replace("rc.1", "rc.2"))).status).toBe(204);
    expect((await app.request(base.replace("macos", "freebsd"))).status).toBe(400);
    expect((await app.request(base.replace("2.0.0-rc.1", "nope"))).status).toBe(400);
  });
  it("app cài từ .deb nhận gói .deb, không có thì rơi về AppImage", async () => {
    directory = await mkdtemp(join(tmpdir(), "hive-release-"));
    const file = join(directory, "release.json");
    const appImage = { url: "https://example.com/app.AppImage", signature: "sig-appimage" };
    const deb = { url: "https://example.com/app.deb", signature: "sig-deb" };
    await writeFile(
      file,
      JSON.stringify({ ...manifest, platforms: { "linux-x86_64": appImage, "linux-x86_64-deb": deb } }),
    );
    const app = createApp({ config: { port: 0, version: "test", desktopReleases: file } });
    const base = "/api/v1/desktop/updates/linux/x86_64/1.0.0";
    expect(await (await app.request(`${base}?installer=deb`)).json()).toMatchObject(deb);
    expect(await (await app.request(base)).json()).toMatchObject(appImage);
    expect(await (await app.request(`${base}?installer=rpm`)).json()).toMatchObject(appImage);
    expect(await (await app.request(`${base}?installer=../x`)).json()).toMatchObject(appImage);
  });
  it("manifest lỗi được xem như không có bản mới", async () => {
    directory = await mkdtemp(join(tmpdir(), "hive-release-"));
    const file = join(directory, "bad.json");
    await writeFile(file, "{");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await findDesktopUpdate(new DesktopReleaseCache(file), "macos", "aarch64", "1.0.0");
    expect(result.kind).toBe("none");
    vi.restoreAllMocks();
  });
});
