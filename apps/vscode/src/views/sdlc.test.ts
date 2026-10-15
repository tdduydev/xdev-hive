import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { hubPathOf, openHubPage, registerSdlcPanel, registerSdlcView, SDLC_OPEN_COMMAND } from "@/views/sdlc.ts";
import { procedures } from "@/webview-host/allowlist/sdlc.ts";
import { provideRpcTransport } from "@/webview-host/transport.ts";
import { settings } from "../../test/vscode-mock.ts";

vi.mock("vscode", async (importOriginal) => {
  const actual = await importOriginal<typeof vscode>();
  return {
    ...actual,
    Uri: {
      ...actual.Uri,
      joinPath: (base: vscode.Uri, ...parts: string[]) => actual.Uri.parse(`${base.toString()}/${parts.join("/")}`),
    },
    env: { ...actual.env, clipboard: { writeText: vi.fn() }, openExternal: vi.fn(async () => true) },
    ViewColumn: { Active: -1 },
    window: {
      ...actual.window,
      showWarningMessage: vi.fn(),
      createWebviewPanel: vi.fn(),
      registerWebviewViewProvider: vi.fn(() => new actual.Disposable(() => {})),
    },
  };
});

const extensionUri = vscode.Uri.file("/extension");
const disposables: { dispose(): void }[] = [];
const context = () => ({ extensionUri, subscriptions: disposables }) as unknown as vscode.ExtensionContext;
const reply = { status: 200, contentType: "application/json", body: '{"json":[]}' };

function mockPanel() {
  let handler: ((value: unknown) => unknown) | undefined;
  const close = new vscode.EventEmitter<void>();
  const webview = {
    cspSource: "https://webview.test",
    html: "",
    options: {},
    asWebviewUri: (uri: vscode.Uri) => vscode.Uri.parse(`https://webview.test/${uri.toString()}`),
    postMessage: vi.fn(async (_message: unknown) => true),
    onDidReceiveMessage: (next: (message: unknown) => unknown) => {
      handler = next;
      return new vscode.Disposable(() => {});
    },
  };
  const panel = { webview, onDidDispose: close.event, reveal: vi.fn(), dispose: vi.fn(() => close.fire()) };
  return {
    panel,
    webview,
    close,
    /** Webview gọi RPC; trả phản hồi host đã gửi lại cho webview. */
    call: async (path: string, body: unknown = {}) => {
      webview.postMessage.mockClear();
      await handler?.({
        type: "rpc",
        id: `id${Math.random().toString(36).slice(2)}`,
        path,
        method: "POST",
        body: JSON.stringify(body),
      });
      return webview.postMessage.mock.calls[0]?.[0] as { status: number; body: string };
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  settings.set("xdevHive.hubUrl", "https://hive.example.com/");
});
afterEach(() => {
  for (const item of disposables.splice(0)) item.dispose();
  provideRpcTransport(undefined);
  settings.clear();
});

describe("hubPathOf", () => {
  it("dựng đường dẫn hub từ trường đã kiểm, bỏ liên kết lạ", () => {
    expect(hubPathOf({ kind: "run", id: "run-1" })).toBe("/runs/run-1");
    expect(hubPathOf({ kind: "review", id: "r1" })).toBe("/knowledge/reviews?id=r1");
    expect(hubPathOf({ kind: "doc", key: "a b/c" })).toBe("/knowledge/docs/a%20b%2Fc/edit");
    expect(hubPathOf({ kind: "task", id: "t" })).toBe("/tasks");
    expect(hubPathOf({ kind: "projectSettings", projectId: "p" })).toBe("/projects");
    expect(hubPathOf({ kind: "run", id: "../../x" })).toBeUndefined();
    expect(hubPathOf({ kind: "doc", key: "" })).toBeUndefined();
    expect(hubPathOf({ kind: "board" })).toBeUndefined();
    expect(hubPathOf({ kind: "javascript:alert(1)" })).toBeUndefined();
    expect(hubPathOf("run")).toBeUndefined();
    expect(hubPathOf(null)).toBeUndefined();
  });
});

describe("openHubPage", () => {
  it("mở trang hub bằng trình duyệt", async () => {
    expect(await openHubPage({ kind: "run", id: "run-1" })).toBe(true);
    expect(vi.mocked(vscode.env.openExternal).mock.calls[0]?.[0].toString()).toBe(
      "https://hive.example.com/runs/run-1",
    );
  });

  it("chưa cấu hình hub thì cảnh báo, không mở", async () => {
    settings.set("xdevHive.hubUrl", "");
    expect(await openHubPage({ kind: "run", id: "run-1" })).toBe(false);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledOnce();
    expect(vscode.env.openExternal).not.toHaveBeenCalled();
  });

  it("hub http ngoài máy bị chặn, liên kết sai hình dạng không mở", async () => {
    settings.set("xdevHive.hubUrl", "ftp://hive.example.com");
    expect(await openHubPage({ kind: "run", id: "run-1" })).toBe(false);
    expect(await openHubPage({ kind: "nope" })).toBe(false);
    expect(vscode.env.openExternal).not.toHaveBeenCalled();
  });
});

describe("allowlist sdlc", () => {
  it("chỉ chứa đường dẫn RPC chính xác, không có thao tác quản trị chế độ hay import", () => {
    for (const path of procedures) expect(path).toMatch(/^\/rpc\/[A-Za-z][A-Za-z0-9]*(\/[A-Za-z][A-Za-z0-9]*)*$/);
    expect(new Set(procedures).size).toBe(procedures.length);
    for (const blocked of ["/rpc/sdlc/modes/save", "/rpc/sdlc/modes/remove", "/rpc/sdlc/import", "/rpc/sdlc/metrics"])
      expect(procedures).not.toContain(blocked);
    expect(procedures).toContain("/rpc/roles/mine");
    expect(procedures).toContain("/rpc/sdlc/board");
  });
});

describe("panel AI SDLC", () => {
  function open() {
    const mock = mockPanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(mock.panel as never);
    const openPanel = registerSdlcPanel(context());
    return { ...mock, openPanel };
  }

  it("đăng ký lệnh mở và dùng lại một panel cho mọi lần mở", () => {
    const { openPanel, panel } = open();
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(SDLC_OPEN_COMMAND, expect.any(Function));
    openPanel({ kind: "questions" });
    openPanel({ kind: "new" });
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledOnce();
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      "xdev-hive.sdlc",
      "Vòng đời phát triển",
      -1,
      expect.objectContaining({ enableScripts: true }),
    );
    expect(panel.reveal).toHaveBeenCalledOnce();
    expect(panel.webview.html).toContain('data-screen="sdlc"');
  });

  it("giữ route chờ cho đến khi webview hỏi sdlcInit, sau đó đẩy route mới bằng postMessage", async () => {
    const { openPanel, call, webview } = open();
    openPanel({ kind: "item", projectKey: "payment-api", number: 12 });
    openPanel({ kind: "questions" });
    expect(webview.postMessage).not.toHaveBeenCalled();
    const first = await call("/rpc/host/sdlcInit");
    expect(JSON.parse(first.body)).toEqual({ route: { kind: "questions" } });
    expect(JSON.parse((await call("/rpc/host/sdlcInit")).body)).toEqual({ route: null });
    webview.postMessage.mockClear();
    openPanel({ kind: "new" });
    expect(webview.postMessage).toHaveBeenCalledWith({ type: "sdlc.navigate", to: { kind: "new" } });
  });

  it("thủ tục thường đi tới transport của hub; chưa có transport thì 503", async () => {
    const { openPanel, call } = open();
    openPanel();
    expect((await call("/rpc/sdlc/board")).status).toBe(503);
    const transport = vi.fn(async () => reply);
    provideRpcTransport(transport);
    expect((await call("/rpc/sdlc/board", { a: 1 })).status).toBe(200);
    expect(transport).toHaveBeenCalledWith(
      { path: "/rpc/sdlc/board", method: "POST", body: '{"a":1}' },
      expect.any(AbortSignal),
    );
  });

  it("thủ tục ngoài allowlist bị từ chối trước khi tới transport", async () => {
    const { openPanel, call } = open();
    openPanel();
    const transport = vi.fn(async () => reply);
    provideRpcTransport(transport);
    expect((await call("/rpc/sdlc/modes/save")).status).toBe(403);
    expect((await call("/rpc/host/other")).status).toBe(403);
    expect(transport).not.toHaveBeenCalled();
  });

  it("sdlcOpen mở trang hub đúng loại liên kết và không chuyển tiếp tới hub", async () => {
    const { openPanel, call } = open();
    openPanel();
    const transport = vi.fn(async () => reply);
    provideRpcTransport(transport);
    expect(JSON.parse((await call("/rpc/host/sdlcOpen", { kind: "run", id: "run-9" })).body)).toBe(true);
    expect(vi.mocked(vscode.env.openExternal).mock.calls[0]?.[0].toString()).toBe(
      "https://hive.example.com/runs/run-9",
    );
    expect(JSON.parse((await call("/rpc/host/sdlcOpen", { kind: "bad" })).body)).toBe(false);
    expect(transport).not.toHaveBeenCalled();
  });

  it("đóng panel thì lần mở sau tạo panel mới", () => {
    const first = mockPanel();
    const second = mockPanel();
    vi.mocked(vscode.window.createWebviewPanel)
      .mockReturnValueOnce(first.panel as never)
      .mockReturnValueOnce(second.panel as never);
    const openPanel = registerSdlcPanel(context());
    openPanel();
    first.close.fire();
    openPanel();
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(2);
  });
});

describe("view ở thanh bên", () => {
  it("đăng ký provider cho xdev-hive.sdlc và dựng HTML màn sdlc", () => {
    registerSdlcView(context());
    const [id, provider] = vi.mocked(vscode.window.registerWebviewViewProvider).mock.calls[0] ?? [];
    expect(id).toBe("xdev-hive.sdlc");
    const { webview, close } = mockPanel();
    provider?.resolveWebviewView(
      { webview, onDidDispose: close.event } as unknown as vscode.WebviewView,
      {} as never,
      {} as never,
    );
    expect(webview.html).toContain('data-screen="sdlc"');
    expect((webview.options as vscode.WebviewOptions).enableScripts).toBe(true);
    close.fire();
  });
});
