/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { attachBridge, isAllowedLink } from "@/webview-host/bridge.ts";
import { renderHtml, webviewOptions } from "@/webview-host/html.ts";
import { register } from "@/webview-host/index.ts";
import { createPanel } from "@/webview-host/panel.ts";
import { provideRpcTransport } from "@/webview-host/transport.ts";
import { registerView } from "@/webview-host/view.ts";

vi.mock("vscode", async (importOriginal) => {
  const actual = await importOriginal<typeof vscode>();
  return {
    ...actual,
    Uri: {
      ...actual.Uri,
      joinPath: (base: vscode.Uri, ...parts: string[]) => actual.Uri.parse(`${base.toString()}/${parts.join("/")}`),
    },
    env: { ...actual.env, clipboard: { writeText: vi.fn() }, openExternal: vi.fn(async () => true) },
    workspace: { ...actual.workspace, fs: { writeFile: vi.fn() } },
    ViewColumn: { Active: -1 },
    window: {
      ...actual.window,
      showSaveDialog: vi.fn(),
      createWebviewPanel: vi.fn(),
      registerWebviewViewProvider: vi.fn(() => new actual.Disposable(() => {})),
    },
  };
});

const extensionUri = vscode.Uri.file("/extension");
const disposables: { dispose(): void }[] = [];
const rpcReply = { status: 200, contentType: "application/json", body: '{"json":{"ok":true}}' };

function mockWebview() {
  let handler: ((value: unknown) => unknown) | undefined;
  const remove = vi.fn();
  const webview = {
    cspSource: "https://webview.test",
    html: "",
    options: {},
    asWebviewUri: (uri: vscode.Uri) => vscode.Uri.parse(`https://webview.test/${uri.toString()}`),
    postMessage: vi.fn(async (_message: unknown) => true),
    onDidReceiveMessage: (next: (message: unknown) => unknown) => {
      handler = next;
      return new vscode.Disposable(remove);
    },
  };
  return {
    webview: webview as unknown as vscode.Webview,
    post: webview.postMessage,
    remove,
    dispatch: async (message: unknown) => {
      await handler?.(message);
    },
  };
}

function context() {
  return { extensionUri, subscriptions: disposables } as unknown as vscode.ExtensionContext;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  for (const item of disposables.splice(0)) item.dispose();
  provideRpcTransport(undefined);
});

describe("HTML và CSP", () => {
  it("nonce mới mỗi lần, chỉ tài nguyên webview và đúng FR-022, không chứa PAT hay hub", () => {
    const { webview } = mockWebview();
    const firstHtml = renderHtml(webview, extensionUri, "sdlc");
    const first = new DOMParser().parseFromString(firstHtml, "text/html");
    const second = new DOMParser().parseFromString(renderHtml(webview, extensionUri, "sdlc"), "text/html");
    const doc = first;
    const nonce = doc.querySelector("script")?.getAttribute("nonce");
    expect(nonce).toMatch(/^[\w+/]{32}$/);
    expect(nonce).not.toBe(second.querySelector("script")?.getAttribute("nonce"));
    expect(doc.querySelector("meta[http-equiv]")?.getAttribute("content")).toBe(
      [
        "default-src 'none'",
        `script-src 'nonce-${nonce}' https://webview.test`,
        "style-src https://webview.test 'unsafe-inline'",
        "img-src https://webview.test data: blob:",
        "font-src https://webview.test",
        "connect-src 'none'",
        "frame-src 'none'",
      ].join("; "),
    );
    expect(doc.querySelector("script")?.getAttribute("src")).toContain("/dist/webview/main.js");
    expect(doc.querySelector("link")?.getAttribute("href")).toContain("/dist/webview/main.css");
    expect(doc.body.dataset.screen).toBe("sdlc");
    expect(firstHtml).not.toMatch(/hive_pat_|hubUrl|unsafe-eval|<iframe/);
    expect(webviewOptions(extensionUri).localResourceRoots?.map(String)).toEqual(["file:///extension/dist/webview"]);
  });

  it("escape thuộc tính HTML", () => {
    const { webview } = mockWebview();
    const html = renderHtml(webview, extensionUri, '"><script>alert(1)</script>' as never);
    expect(html).not.toContain("<script>alert(1)</script>");
    const dom = new DOMParser().parseFromString(html, "text/html");
    expect(dom.querySelectorAll("script")).toHaveLength(1);
  });
});

describe("cầu nối host", () => {
  it.each(["review", "sdlc", "artifacts", "chat", "doc-review"] as const)(
    "%s từ chối RPC ngoài danh sách cho phép",
    async (screen) => {
      const view = mockWebview();
      const rpc = vi.fn(async () => rpcReply);
      disposables.push(attachBridge(view.webview, screen, { rpc }));
      await view.dispatch({
        type: "rpc",
        id: "one",
        path: "/rpc/unknownProcedure",
        method: "POST",
        body: "{}",
        screen: "review",
      });
      expect(rpc).not.toHaveBeenCalled();
      expect(view.post).toHaveBeenCalledWith(expect.objectContaining({ id: "one", status: 403 }));
    },
  );

  it("thủ tục được phép giữ query/body, bỏ header và URL do webview gửi", async () => {
    const view = mockWebview();
    const rpc = vi.fn(async () => rpcReply);
    disposables.push(attachBridge(view.webview, "sdlc", { rpc, procedures: ["/rpc/sdlc/items/list"] }));
    await view.dispatch({
      type: "rpc",
      id: "one",
      path: "/rpc/sdlc/items/list?data=%7B%7D",
      method: "GET",
      body: null,
      headers: { authorization: "test" },
      hubUrl: "https://other.test",
    });
    expect(rpc).toHaveBeenCalledWith(
      { path: "/rpc/sdlc/items/list?data=%7B%7D", method: "GET", body: null },
      expect.any(AbortSignal),
    );
    expect(view.post).toHaveBeenCalledWith({ type: "result", id: "one", ...rpcReply });
  });

  it.each([
    "https://hub.test/rpc/sdlc/get",
    "//hub.test/rpc/sdlc/get",
    "/rpc/sdlc/../get",
    "/rpc/sdlc/%67et",
    "/rpc/sdlc/get#x",
    "/rpc/sdlc/get/extra",
    "/rpc/sdlc/getOther",
  ])("từ chối đường dẫn %s", async (path) => {
    const view = mockWebview();
    const rpc = vi.fn(async () => rpcReply);
    disposables.push(attachBridge(view.webview, "sdlc", { rpc, procedures: ["/rpc/sdlc/get"] }));
    await view.dispatch({ type: "rpc", id: "one", path, method: "POST", body: "{}" });
    expect(rpc).not.toHaveBeenCalled();
    expect(view.post).toHaveBeenCalledWith(expect.objectContaining({ status: expect.any(Number) }));
  });

  it("bỏ thông điệp sai, chặn method/body sai và giới hạn kích thước", async () => {
    const view = mockWebview();
    const rpc = vi.fn(async () => rpcReply);
    disposables.push(attachBridge(view.webview, "sdlc", { rpc, procedures: ["/rpc/sdlc/get"] }));
    for (const message of [null, "text", {}, { type: "rpc", id: {} }]) await view.dispatch(message);
    expect(view.post).not.toHaveBeenCalled();
    for (const fields of [
      { method: "DELETE" },
      { body: {} },
      { method: "GET", body: "{}" },
      { body: "x".repeat(1024 * 1024 + 1) },
    ]) {
      await view.dispatch({ type: "rpc", id: "one", path: "/rpc/sdlc/get", method: "POST", body: "{}", ...fields });
      expect(view.post).toHaveBeenLastCalledWith(expect.objectContaining({ status: 400 }));
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("transport đăng ký sau host dùng được và không bị xoá bởi đăng ký cũ", async () => {
    const view = mockWebview();
    const old = provideRpcTransport(vi.fn(async () => rpcReply));
    const rpc = vi.fn(async () => rpcReply);
    const current = provideRpcTransport(rpc);
    register(context());
    old.dispose();
    disposables.push(attachBridge(view.webview, "sdlc", { procedures: ["/rpc/sdlc/get"] }));
    await view.dispatch({ type: "rpc", id: "one", path: "/rpc/sdlc/get", method: "POST", body: "{}" });
    expect(rpc).toHaveBeenCalledOnce();
    current.dispose();
    await view.dispatch({ type: "rpc", id: "two", path: "/rpc/sdlc/get", method: "POST", body: "{}" });
    expect(view.post).toHaveBeenLastCalledWith(expect.objectContaining({ status: 503 }));
  });

  it("không trả token từ lỗi hoặc body hub", async () => {
    const view = mockWebview();
    const rpc = vi
      .fn()
      .mockRejectedValueOnce(new Error("hive_pat_test_fixture"))
      .mockResolvedValueOnce({ ...rpcReply, body: '{"json":"hive_pat_test_fixture"}' });
    disposables.push(attachBridge(view.webview, "sdlc", { rpc, procedures: ["/rpc/sdlc/get"] }));
    for (const id of ["one", "two"])
      await view.dispatch({ type: "rpc", id, path: "/rpc/sdlc/get", method: "POST", body: "{}" });
    expect(view.post).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(view.post.mock.calls)).not.toContain("hive_pat_");
  });

  it("hủy yêu cầu, bỏ ID trùng và không gửi reply sau khi đóng", async () => {
    const view = mockWebview();
    let finish: ((value: typeof rpcReply) => void) | undefined;
    const rpc = vi.fn(
      (_request, _signal) =>
        new Promise<typeof rpcReply>((resolve) => {
          finish = resolve;
        }),
    );
    const bridge = attachBridge(view.webview, "sdlc", { rpc, procedures: ["/rpc/sdlc/get"] });
    const message = { type: "rpc", id: "one", path: "/rpc/sdlc/get", method: "POST", body: "{}" };
    const running = view.dispatch(message);
    await view.dispatch(message);
    expect(rpc).toHaveBeenCalledOnce();
    await view.dispatch({ type: "cancel", id: "one" });
    expect(rpc.mock.calls[0]?.[1].aborted).toBe(true);
    bridge.dispose();
    finish?.(rpcReply);
    await running;
    expect(view.post).not.toHaveBeenCalled();
    expect(view.remove).toHaveBeenCalledOnce();
  });

  it("giới hạn yêu cầu đồng thời và abort tất cả khi đóng", async () => {
    const view = mockWebview();
    const signals: AbortSignal[] = [];
    const waiting: (() => void)[] = [];
    const bridge = attachBridge(view.webview, "sdlc", {
      procedures: ["/rpc/sdlc/get"],
      rpc: (_request, signal) =>
        new Promise((resolve) => {
          signals.push(signal);
          waiting.push(() => resolve(rpcReply));
        }),
    });
    const running = Array.from({ length: 32 }, (_, id) =>
      view.dispatch({
        type: "rpc",
        id: String(id),
        path: "/rpc/sdlc/get",
        method: "POST",
        body: "{}",
      }),
    );
    await view.dispatch({ type: "rpc", id: "overflow", path: "/rpc/sdlc/get", method: "POST", body: "{}" });
    expect(signals).toHaveLength(32);
    expect(view.post).toHaveBeenLastCalledWith(expect.objectContaining({ id: "overflow", status: 429 }));
    bridge.dispose();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    for (const finish of waiting) finish();
    await Promise.all(running);
    expect(view.post).toHaveBeenCalledOnce();
  });

  it("clipboard, lưu tệp qua hộp thoại, hủy lưu không ghi tệp", async () => {
    const view = mockWebview();
    disposables.push(attachBridge(view.webview, "sdlc"));
    await view.dispatch({ type: "clipboard.write", id: "one", text: "Nội dung" });
    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith("Nội dung");
    const uri = vscode.Uri.file("/chosen.txt");
    vi.mocked(vscode.window.showSaveDialog).mockResolvedValueOnce(uri).mockResolvedValueOnce(undefined);
    await view.dispatch({ type: "download", id: "two", text: "Nội dung", path: "/untrusted.txt" });
    expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(uri, Buffer.from("Nội dung"));
    await view.dispatch({ type: "download", id: "three", text: "Bỏ" });
    expect(vscode.workspace.fs.writeFile).toHaveBeenCalledOnce();
    expect(view.post).toHaveBeenLastCalledWith(expect.objectContaining({ body: "false" }));
  });

  it("chỉ mở https hoặc đúng origin của hub HTTP", async () => {
    const view = mockWebview();
    disposables.push(attachBridge(view.webview, "sdlc", { hubUrl: () => "http://hub.test:3000" }));
    for (const url of [
      "command:workbench.action.openSettings",
      "file:///tmp/test",
      "http://other.test",
      "http://hub.test:3000.evil.test",
      "https://user:pass@example.test",
    ]) {
      await view.dispatch({ type: "openExternal", id: "bad", url });
    }
    expect(vscode.env.openExternal).not.toHaveBeenCalled();
    for (const url of ["https://example.test", "http://hub.test:3000/task/1"])
      await view.dispatch({ type: "openExternal", id: "good", url });
    expect(vscode.env.openExternal).toHaveBeenCalledTimes(2);
    expect(isAllowedLink("data:text/html,x", "")).toBe(false);
  });
});

describe("vòng đời panel và view", () => {
  it("panel chỉ dùng dist/webview và đóng thì tháo listener", () => {
    const view = mockWebview();
    const close = new vscode.EventEmitter<void>();
    const panel = { webview: view.webview, onDidDispose: close.event, dispose: vi.fn() };
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(panel as never);
    expect(createPanel(context(), "sdlc")).toBe(panel);
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      "xdev-hive.sdlc",
      "Vòng đời phát triển",
      -1,
      expect.objectContaining({ enableScripts: true }),
    );
    expect(view.webview.html).toContain('data-screen="sdlc"');
    close.fire();
    expect(view.remove).toHaveBeenCalledOnce();
    close.dispose();
  });

  it("view đăng ký provider, resolve lại tạo nonce mới, dispose tháo bridge", () => {
    registerView(context(), "xdev-hive.sdlc", "sdlc");
    const provider = vi.mocked(vscode.window.registerWebviewViewProvider).mock.calls[0]?.[1];
    const view = mockWebview();
    const close = new vscode.EventEmitter<void>();
    const value = { webview: view.webview, onDidDispose: close.event } as unknown as vscode.WebviewView;
    provider?.resolveWebviewView(value, {} as never, {} as never);
    const first = view.webview.html;
    close.fire();
    provider?.resolveWebviewView(value, {} as never, {} as never);
    expect(view.webview.html).not.toBe(first);
    expect(view.webview.options.enableScripts).toBe(true);
    expect(view.webview.options.localResourceRoots?.map(String)).toEqual(["file:///extension/dist/webview"]);
    close.fire();
    expect(view.remove).toHaveBeenCalledTimes(2);
    close.dispose();
  });
});
