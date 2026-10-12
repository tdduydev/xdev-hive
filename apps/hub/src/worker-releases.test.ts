import { describe, expect, it } from "vitest";
import { installCommands, WorkerReleaseCache } from "./modules/fleet/index.ts";

const github = (tag: string) =>
  new Response(
    JSON.stringify({
      tag_name: tag,
      html_url: `https://github.com/tdduydev/xdev-hive/releases/tag/${tag}`,
      published_at: "2026-10-12T03:00:00Z",
    }),
    { status: 200 },
  );

describe("bản worker mới nhất", () => {
  it("bỏ tiền tố v, giữ một giờ, nhiều request cùng lúc chỉ hỏi GitHub một lần", async () => {
    let now = 0;
    let calls = 0;
    const cache = new WorkerReleaseCache(
      "https://api.github.test/latest",
      () => now,
      async () => {
        calls++;
        return github(calls === 1 ? "v0.1.0" : "v0.2.0");
      },
    );
    const [a, b] = await Promise.all([cache.get(), cache.get()]);
    expect(a).toEqual({
      version: "0.1.0",
      url: "https://github.com/tdduydev/xdev-hive/releases/tag/v0.1.0",
      publishedAt: "2026-10-12T03:00:00.000Z",
    });
    expect(b).toEqual(a);
    now = 3_599_999;
    expect((await cache.get())?.version).toBe("0.1.0");
    expect(calls).toBe(1);
    now = 3_600_000;
    expect((await cache.get())?.version).toBe("0.2.0");
    expect(calls).toBe(2);
  });

  it("GitHub lỗi thì giữ kết quả cũ và thử lại sau 5 phút", async () => {
    let now = 0;
    let fail = false;
    let calls = 0;
    const cache = new WorkerReleaseCache(
      "https://api.github.test/latest",
      () => now,
      async () => {
        calls++;
        return fail ? new Response("rate limited", { status: 403 }) : github("v0.1.0");
      },
    );
    await cache.get();
    fail = true;
    now = 3_600_000;
    expect((await cache.get())?.version).toBe("0.1.0");
    now += 299_999;
    await cache.get();
    expect(calls).toBe(2);
    now += 1;
    await cache.get();
    expect(calls).toBe(3);
  });

  it("repo chưa có bản phát hành, tag lạ hoặc không cấu hình nguồn thì trả null", async () => {
    expect(await new WorkerReleaseCache(undefined).get()).toBeNull();
    const none = new WorkerReleaseCache("https://x.test", Date.now, async () => new Response("{}", { status: 404 }));
    expect(await none.get()).toBeNull();
    const odd = new WorkerReleaseCache("https://x.test", Date.now, async () => github("nightly"));
    expect(await odd.get()).toBeNull();
  });
});

describe("lệnh cài một dòng", () => {
  it("máy dev cài dịch vụ; runner host thì không; Windows dùng PowerShell", () => {
    const worker = installCommands("https://hive.example.com", "hwr_abc", "worker");
    expect(worker.installCommand).toBe(
      "curl -fsSL https://github.com/tdduydev/xdev-hive/releases/latest/download/install.sh | sh -s -- --hub https://hive.example.com --token hwr_abc",
    );
    expect(worker.installCommandWindows).toBe(
      'irm https://github.com/tdduydev/xdev-hive/releases/latest/download/install.ps1 -OutFile "$env:TEMP\\hive-install.ps1"; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\\hive-install.ps1" -Hub https://hive.example.com -Token hwr_abc',
    );
    expect(installCommands("https://hive.example.com", "hwr_abc", "host").installCommand).toMatch(/ --no-service$/);
  });
});
