/// <reference lib="dom" />
// @vitest-environment jsdom

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ReadableStream, TransformStream, WritableStream } from "node:stream/web";
import { TextDecoder, TextEncoder } from "node:util";
import { runInNewContext } from "node:vm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

interface TestBridge {
  fetch(request: Request): Promise<Response>;
  writeClipboard(text: string): Promise<boolean>;
  download(text: string): Promise<boolean>;
  openExternal(url: string): Promise<boolean>;
  getState<T>(): T | undefined;
  setState<T>(state: T): T;
  dispose(): void;
}

const root = process.cwd();
let bridgeBundle = "";
let themeBundle = "";
const cleanups: (() => void)[] = [];

beforeAll(() => {
  // Dựng trong Node riêng vì jsdom và esbuild dùng hai realm Uint8Array khác nhau.
  for (const [entry, save] of [
    [
      "bridge",
      (code: string) => {
        bridgeBundle = code;
      },
    ],
    [
      "theme",
      (code: string) => {
        themeBundle = code;
      },
    ],
  ] as const) {
    save(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import { build } from "esbuild";
      const result = await build({ entryPoints: ["webview/${entry}.ts"], bundle: true, platform: "browser", format: "iife", globalName: "BrowserModule", write: false, logLevel: "silent" });
      process.stdout.write(result.outputFiles[0].text);
    `,
        ],
        { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      ),
    );
  }
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  document.body.className = "";
  document.documentElement.lang = "vi";
});

function loadBridge() {
  const sent: Record<string, unknown>[] = [];
  let state: unknown;
  const api = {
    postMessage: vi.fn((message: Record<string, unknown>) => sent.push(message)),
    getState: () => state,
    setState: (next: unknown) => {
      state = next;
      return next;
    },
  };
  const acquire = vi.fn(() => api);
  const context = {
    window,
    document,
    Request,
    Response,
    URL,
    URLSearchParams,
    Headers,
    AbortController,
    DOMException,
    crypto,
    setTimeout,
    clearTimeout,
    ReadableStream,
    TransformStream,
    WritableStream,
    TextEncoder,
    TextDecoder,
    Blob,
    FormData,
    File,
    acquireVsCodeApi: acquire,
    BrowserModule: undefined as unknown as {
      bridge: TestBridge;
      hub: { sdlc: { items: { list(input: unknown): Promise<unknown> } } };
    },
  };
  runInNewContext(bridgeBundle, context);
  const { bridge, hub } = context.BrowserModule;
  cleanups.push(() => bridge.dispose());
  return {
    bridge,
    hub,
    sent,
    acquire,
    api,
    reply: (id: unknown, body = "true", status = 200) =>
      window.dispatchEvent(
        new MessageEvent("message", { data: { type: "result", id, body, status, contentType: "application/json" } }),
      ),
  };
}

describe("bundle cầu nối trình duyệt", () => {
  it("fake fetch gửi query/body, ghép phản hồi theo ID kể cả khi đảo thứ tự", async () => {
    const client = loadBridge();
    const first = client.bridge.fetch(new Request("https://hive.invalid/rpc/sdlc/get?data=abc"));
    const second = client.bridge.fetch(
      new Request("https://hive.invalid/rpc/sdlc/save", { method: "POST", body: "{}" }),
    );
    await vi.waitFor(() => expect(client.sent).toHaveLength(2));
    expect(client.sent[0]).toMatchObject({ type: "rpc", path: "/rpc/sdlc/get?data=abc", body: null, method: "GET" });
    expect(client.sent[1]).toMatchObject({ path: "/rpc/sdlc/save", body: "{}", method: "POST" });
    client.reply("unrelated", "false");
    client.reply(client.sent[1]?.id, '{"saved":true}');
    client.reply(client.sent[0]?.id, '{"ok":true}');
    expect(await (await first).json()).toEqual({ ok: true });
    expect(await (await second).json()).toEqual({ saved: true });
    expect(client.acquire).toHaveBeenCalledOnce();
  });

  it("oRPC dùng fake fetch thật và đọc được lỗi chuẩn từ host", async () => {
    const client = loadBridge();
    const result = client.hub.sdlc.items.list({ projectId: "test" }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    expect(client.sent[0]?.type).toBe("rpc");
    expect(String(client.sent[0]?.path).split("?")[0]).toBe("/rpc/sdlc/items/list");
    client.reply(
      client.sent[0]?.id,
      JSON.stringify({ json: { defined: false, code: "FORBIDDEN", status: 403, message: "Không được phép." } }),
      403,
    );
    expect(await result).toMatchObject({ code: "FORBIDDEN", status: 403, message: "Không được phép." });
  });

  it("không dùng fetch mạng, chặn URL khác và chuyển thao tác native qua postMessage", async () => {
    const client = loadBridge();
    await expect(client.bridge.fetch(new Request("https://evil.test/rpc/sdlc/get"))).rejects.toThrow(
      "Yêu cầu không hợp lệ.",
    );
    const clipboard = client.bridge.writeClipboard("Sao chép");
    client.reply(client.sent[0]?.id);
    expect(await clipboard).toBe(true);
    const download = client.bridge.download("Tệp");
    client.reply(client.sent[1]?.id, "false");
    expect(await download).toBe(false);
    const link = client.bridge.openExternal("https://example.test");
    client.reply(client.sent[2]?.id);
    expect(await link).toBe(true);
    expect(client.sent.map((message) => message.type)).toEqual(["clipboard.write", "download", "openExternal"]);
    expect(client.sent[0]?.text).toBe("Sao chép");
    client.bridge.setState({ selected: "item-1" });
    expect(client.bridge.getState()).toEqual({ selected: "item-1" });
  });

  it("abort và dispose hủy host, phản hồi đến muộn bị bỏ", async () => {
    const client = loadBridge();
    const controller = new AbortController();
    const request = client.bridge
      .fetch(new Request("https://hive.invalid/rpc/sdlc/get", { signal: controller.signal }))
      .catch((error: unknown) => error);
    controller.abort();
    expect(await request).toHaveProperty("name", "AbortError");
    expect(client.sent[1]).toEqual({ type: "cancel", id: client.sent[0]?.id });
    client.reply(client.sent[0]?.id);
    const action = client.bridge.writeClipboard("test").catch((error: unknown) => error);
    client.bridge.dispose();
    expect(await action).toHaveProperty("message", "Màn hình đã đóng.");
    await expect(client.bridge.openExternal("https://example.test")).rejects.toThrow("Màn hình đã đóng.");
  });

  it("timeout dọn hàng chờ, lỗi postMessage không để treo promise", async () => {
    vi.useFakeTimers();
    const client = loadBridge();
    const action = client.bridge.writeClipboard("test").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await action).toHaveProperty("message", "Yêu cầu quá thời gian chờ.");
    expect(client.sent[1]?.type).toBe("cancel");
    client.api.postMessage.mockImplementationOnce(() => {
      throw new Error("test");
    });
    await expect(client.bridge.writeClipboard("test")).rejects.toThrow("Không thực hiện được thao tác.");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("đóng vẫn giải phóng yêu cầu khi kênh postMessage đã hỏng", async () => {
    vi.useFakeTimers();
    const client = loadBridge();
    const action = client.bridge.writeClipboard("test").catch((error: unknown) => error);
    client.api.postMessage.mockImplementation(() => {
      throw new Error("Kênh đã đóng");
    });
    expect(() => client.bridge.dispose()).not.toThrow();
    expect(await action).toHaveProperty("message", "Màn hình đã đóng.");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("theme", () => {
  it("theo theme sáng/tối/tương phản cao và tháo observer khi đóng", async () => {
    const context = { document, MutationObserver, BrowserModule: undefined as unknown as { syncTheme(): () => void } };
    runInNewContext(themeBundle, context);
    const dispose = context.BrowserModule.syncTheme();
    cleanups.push(dispose);
    for (const [theme, dark] of [
      ["vscode-dark", true],
      ["vscode-light", false],
      ["vscode-high-contrast", true],
      ["vscode-high-contrast-light", false],
    ] as const) {
      document.body.className = theme;
      await Promise.resolve();
      expect(document.documentElement.classList.contains("dark")).toBe(dark);
      expect(document.documentElement.style.colorScheme).toBe(dark ? "dark" : "light");
    }
    dispose();
    document.body.className = "vscode-dark";
    await Promise.resolve();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    const css = await readFile(join(root, "webview", "styles.css"), "utf8");
    expect(css).toContain("--background: var(--vscode-editor-background)");
    expect(css).toContain("--primary: var(--vscode-button-background)");
    expect(css).toContain("--vscode-contrastBorder");
  });
});
