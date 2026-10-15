import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { register } from "@/views/artifacts.ts";
import type { RpcTransport } from "@/webview-host/types.ts";

const mocks = vi.hoisted(() => ({
  token: vi.fn(),
  frame: vi.fn(),
  request: vi.fn(),
  panel: vi.fn(),
  rpc: undefined as RpcTransport | undefined,
  resolveView: (_view: unknown) => {},
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  sessions: (_event: { provider: { id: string } }) => {},
}));
vi.mock("@/webview-host/bridge.ts", () => ({
  attachBridge: (_webview: unknown, _screen: unknown, options: { rpc: RpcTransport }) => {
    mocks.rpc = options.rpc;
    return { dispose: vi.fn() };
  },
}));
vi.mock("@/webview-host/html.ts", () => ({ renderHtml: () => "safe html", webviewOptions: () => ({}) }));
vi.mock("@/auth/index.ts", () => ({ auth: { token: mocks.token } }));
vi.mock("@/hub/client.ts", () => ({
  orgFromToken: () => "org",
  createHubClient: () => ({ rpc: { artifacts: { frameDocument: mocks.frame } }, request: mocks.request }),
}));
vi.mock("@/artifacts/libraries.ts", () => ({
  loadLibraries: async (root: string) => join(root, "a".repeat(64)),
  verifyCachedLibraries: vi.fn(),
}));
vi.mock("@/artifacts/panel.ts", () => ({ openArtifactPanel: mocks.panel }));
vi.mock("vscode", async (importOriginal) => {
  const actual = await importOriginal<typeof vscode>();
  return {
    ...actual,
    ColorThemeKind: { Light: 1 },
    authentication: {
      onDidChangeSessions: (listener: typeof mocks.sessions) => {
        mocks.sessions = listener;
        return new actual.Disposable(() => {});
      },
    },
    window: {
      ...actual.window,
      activeColorTheme: { kind: 1 },
      registerWebviewViewProvider: vi.fn((_id: string, provider: { resolveWebviewView(view: unknown): void }) => {
        mocks.resolveView = provider.resolveWebviewView;
        return new actual.Disposable(() => {});
      }),
    },
    commands: {
      ...actual.commands,
      registerCommand: (name: string, action: (...args: unknown[]) => unknown) => {
        mocks.commands.set(name, action);
        return new actual.Disposable(() => {});
      },
    },
  };
});
let root: string;
const subscriptions: vscode.Disposable[] = [];
const ref = { id: "00000000-0000-4000-8000-000000000001", version: 1 };
const command = (name: string, value?: unknown) => mocks.commands.get(`xdevHive.artifact.${name}`)?.(value);
beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), "hive-artifact-view-"));
  const mock = await import("../../test/vscode-mock.ts");
  mock.settings.set("xdevHive.hubUrl", "https://hub.test");
  mocks.token.mockResolvedValue("token-a");
  mocks.frame.mockResolvedValue({ html: "document", csp: "unused" });
  mocks.panel.mockImplementation(() => ({ dispose: vi.fn(), onDidDispose: vi.fn() }));
  register({ globalStorageUri: vscode.Uri.file(root), subscriptions } as unknown as vscode.ExtensionContext);
});
afterEach(async () => {
  for (const item of subscriptions.splice(0)) item.dispose();
  await rm(root, { recursive: true, force: true });
});
it("không có hub hoặc phiên thì không gọi mạng", async () => {
  const mock = await import("../../test/vscode-mock.ts");
  mock.settings.set("xdevHive.hubUrl", "");
  await command("open", ref);
  mock.settings.set("xdevHive.hubUrl", "https://hub.test");
  mocks.token.mockResolvedValue(undefined);
  await command("open", ref);
  expect(mocks.frame).not.toHaveBeenCalled();
  expect(mocks.request).not.toHaveBeenCalled();
});
it("đọc lại offline nhưng không dùng cache sau 403 hoặc cho token khác", async () => {
  expect(await command("open", ref)).toBe(true);
  mocks.frame.mockRejectedValue(new TypeError("offline"));
  expect(await command("open", ref)).toBe(true);
  mocks.frame.mockRejectedValue({ status: 403 });
  await command("open", ref);
  expect(mocks.panel).toHaveBeenCalledTimes(2);
  mocks.frame.mockRejectedValue(new TypeError("offline"));
  mocks.token.mockResolvedValue("token-b");
  await command("open", ref);
  expect(mocks.panel).toHaveBeenCalledTimes(2);
});
it("đăng xuất đóng panel và xoá nội dung đệm", async () => {
  await command("open", ref);
  mocks.sessions({ provider: { id: "xdev-hive" } });
  // Lệnh clear cũng đợi hàng đợi xoá của sự kiện phiên hoàn tất.
  await command("clearCache");
  expect(mocks.panel.mock.results[0]?.value.dispose).toHaveBeenCalled();
  expect(await readdir(join(root, "artifacts")).catch(() => [])).toEqual([]);
});
it("đăng xuất giữa lúc tải không mở panel hay ghi cache trở lại", async () => {
  let finish: ((value: { html: string }) => void) | undefined;
  mocks.frame.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = command("open", ref);
  await vi.waitFor(() => expect(finish).toBeDefined());
  mocks.sessions({ provider: { id: "xdev-hive" } });
  finish?.({ html: "private" });
  expect(await pending).toBe(false);
  await command("clearCache");
  expect(mocks.panel).not.toHaveBeenCalled();
  expect(await readdir(join(root, "artifacts")).catch(() => [])).toEqual([]);
});

it("view giữ phản hồi đọc offline theo phiên và xoá cả khi đăng xuất", async () => {
  const view = { webview: { options: {}, html: "" }, onDidDispose: vi.fn() };
  mocks.resolveView(view);
  const request = { path: "/rpc/artifacts/get?json=test", method: "GET" as const, body: null };
  mocks.request.mockResolvedValue(
    new Response('{"json":{"title":"Bản đã mở"}}', { headers: { "content-type": "application/json" } }),
  );
  const first = await mocks.rpc?.(request, new AbortController().signal);
  mocks.request.mockRejectedValue(new TypeError("offline"));
  expect(await mocks.rpc?.(request, new AbortController().signal)).toEqual(first);
  mocks.sessions({ provider: { id: "xdev-hive" } });
  await command("clearCache");
  await expect(mocks.rpc?.(request, new AbortController().signal)).rejects.toThrow("offline");
});
