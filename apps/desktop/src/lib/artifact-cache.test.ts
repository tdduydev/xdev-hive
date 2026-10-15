import { buildCsp } from "@xdev-hive/artifacts-runtime";
import type { ArtifactDetail } from "@xdev-hive/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  APP_FRAME_CSP,
  type CachedSummary,
  cacheClear,
  cacheGet,
  cacheList,
  cachePut,
  cachedFrameUrl,
  latestPerArtifact,
} from "@/lib/artifact-cache.ts";

type Call = { command: string; args?: Record<string, unknown> | undefined };

function fakeTauri(reply: unknown) {
  const calls: Call[] = [];
  window.__TAURI__ = {
    core: {
      invoke: async <T>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        return reply as T;
      },
    },
  };
  return calls;
}

afterEach(() => {
  delete window.__TAURI__;
});

const ID = "0a0a0a0a-0000-4000-8000-00000000000a";

function summary(id: string, version: number, savedAt: number): CachedSummary {
  return {
    id,
    version,
    artifact: {} as CachedSummary["artifact"],
    themes: ["light"],
    savedAt,
    sizeBytes: 10,
  };
}

describe("artifact cache", () => {
  it("CSP của khung app giống buildCsp của runtime với nguồn thư viện của app", () => {
    expect(APP_FRAME_CSP).toBe(buildCsp({ libBase: "hive-artifact://localhost/lib/" }));
  });

  it("gọi lệnh Rust, không gửi phạm vi hồ sơ hay tổ chức từ giao diện", async () => {
    const calls = fakeTauri(null);
    const detail = { artifact: { id: ID }, version: { version: 2 } } as unknown as ArtifactDetail;
    await cachePut(detail, { theme: "dark", html: "<html></html>" });
    await cacheGet(ID);
    await cacheGet(ID, 1);
    await cacheList();
    await cacheClear([ID]);
    await cacheClear();
    expect(calls).toEqual([
      { command: "artifact_cache_put", args: { entry: { detail, frame: { theme: "dark", html: "<html></html>" } } } },
      { command: "artifact_cache_get", args: { id: ID, version: null } },
      { command: "artifact_cache_get", args: { id: ID, version: 1 } },
      { command: "artifact_cache_list", args: undefined },
      { command: "artifact_cache_clear", args: { ids: [ID] } },
      { command: "artifact_cache_clear", args: { ids: null } },
    ]);
  });

  it("ngoài app thì báo lỗi thay vì im lặng", async () => {
    await expect(cacheList()).rejects.toThrow("Chỉ chạy được trong app xDev Hive.");
  });

  it("địa chỉ khung theo nền tảng", () => {
    expect(cachedFrameUrl(ID, 3, "dark", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe(
      `hive-artifact://localhost/frame/${ID}/3?theme=dark`,
    );
    expect(cachedFrameUrl(ID, 3, "light", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/140")).toBe(
      `http://hive-artifact.localhost/frame/${ID}/3?theme=light`,
    );
  });

  it("danh sách offline giữ phiên bản mới nhất của mỗi artifact", () => {
    const other = "0b0b0b0b-0000-4000-8000-00000000000b";
    const list = [summary(ID, 1, 30), summary(ID, 3, 10), summary(other, 1, 20)];
    expect(latestPerArtifact(list).map((s) => [s.id, s.version])).toEqual([
      [other, 1],
      [ID, 3],
    ]);
  });
});
