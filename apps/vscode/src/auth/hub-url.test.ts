import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { hubUrl, normalizeHub, setHubUrl } from "@/auth/hub-url.ts";

const mocks = vi.hoisted(() => ({ input: vi.fn(), update: vi.fn(), configured: "" }));
vi.mock("vscode", async (original) => {
  const base = await original<typeof vscode>();
  return {
    ...base,
    ConfigurationTarget: { Global: 1 },
    workspace: {
      ...base.workspace,
      getConfiguration: () => ({
        get: (_key: string, fallback: unknown) => fallback,
        inspect: () => ({ globalValue: mocks.configured }),
        update: mocks.update,
      }),
    },
    window: { ...base.window, showInputBox: mocks.input },
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mocks.configured = "";
});

describe("địa chỉ hub", () => {
  it("setting máy rồi hive.json rồi worker.json; không lấy token trong file", async () => {
    const dir = await mkdtemp(join(process.cwd(), ".auth-test-"));
    const files = [join(dir, "hive.json"), join(dir, "worker.json")];
    try {
      await writeFile(files[0] ?? "", JSON.stringify({ hubUrl: "https://cli.example/", token: "ignored" }));
      await writeFile(files[1] ?? "", JSON.stringify({ hubUrl: "https://worker.example/" }));
      mocks.configured = "HTTPS://CONFIG.example///";
      expect(await hubUrl(files)).toBe("https://config.example");
      mocks.configured = "";
      expect(await hubUrl(files)).toBe("https://cli.example");
      await writeFile(files[0] ?? "", "broken");
      expect(await hubUrl(files)).toBe("https://worker.example");
      expect(await hubUrl([])).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("từ chối URL có credentials, protocol lạ, query và fragment", () => {
    for (const value of [
      "file:///tmp/hub",
      "https://user:secret@hub.example",
      "https://hub.example?token=x",
      "https://hub.example/#x",
      "garbage",
    ])
      expect(() => normalizeHub(value)).toThrow("Địa chỉ hub");
  });

  it("kiểm health trước khi lưu vào cấu hình Global", async () => {
    mocks.input.mockResolvedValue("https://hub.example/");
    const fetcher = vi.fn().mockResolvedValue(Response.json({ status: "ok" }));
    vi.stubGlobal("fetch", fetcher);
    expect(await setHubUrl()).toBe("https://hub.example");
    expect(fetcher).toHaveBeenCalledWith(
      "https://hub.example/api/v1/health",
      expect.objectContaining({ redirect: "error" }),
    );
    expect(mocks.update).toHaveBeenCalledWith("hubUrl", "https://hub.example", 1);
    mocks.update.mockClear();
    fetcher.mockResolvedValue(Response.json({ status: "broken" }));
    await expect(setHubUrl()).rejects.toThrow("hub không hợp lệ");
    expect(mocks.update).not.toHaveBeenCalled();
    mocks.input.mockResolvedValue(undefined);
    expect(await setHubUrl()).toBeUndefined();
  });
});
