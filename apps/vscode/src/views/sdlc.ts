import * as vscode from "vscode";
import { config } from "@/lib/config.ts";
import { addStrings, t } from "@/lib/i18n.ts";
import { attachBridge, isAllowedLink } from "@/webview-host/bridge.ts";
import { renderHtml, webviewOptions } from "@/webview-host/html.ts";
import { getRpcTransport } from "@/webview-host/transport.ts";
import type { RpcReply, RpcRequest } from "@/webview-host/types.ts";

addStrings(
  {
    "sdlc.noHub": "Chưa cấu hình hub xDev Hive nên không mở được trang này.",
    "sdlc.unsafeLink": "Không mở được liên kết này.",
  },
  {
    "sdlc.noHub": "No xDev Hive hub is configured, so this page cannot be opened.",
    "sdlc.unsafeLink": "This link cannot be opened.",
  },
);

export const SDLC_VIEW = "xdev-hive.sdlc";
export const SDLC_OPEN_COMMAND = "xdevHive.sdlc.open";

/** Màn trong webview AI SDLC; webview tự kiểm lại hình dạng nên host chỉ cần đúng kiểu khi gửi. */
export type SdlcRoute =
  | { kind: "board"; projectId?: string; modeRef?: string }
  | { kind: "new" }
  | { kind: "questions" }
  | { kind: "item"; projectKey: string; number: number; tab?: string };

const ID = /^[\w-]{1,128}$/;

function json(value: unknown, status = 200): RpcReply {
  return { status, contentType: "application/json", body: JSON.stringify(value) };
}

/**
 * Trang web của hub tương ứng liên kết mà webview không tự hiển thị được. Webview không biết URL hub và không được
 * chọn nó, nên chỉ gửi `SdlcLink`; host dựng đường dẫn từ các trường đã kiểm.
 */
export function hubPathOf(link: unknown): string | undefined {
  if (typeof link !== "object" || link === null) return undefined;
  const { kind, id, key } = link as Record<string, unknown>;
  switch (kind) {
    case "run":
      return typeof id === "string" && ID.test(id) ? `/runs/${encodeURIComponent(id)}` : undefined;
    case "review":
      return typeof id === "string" && ID.test(id) ? `/knowledge/reviews?id=${encodeURIComponent(id)}` : undefined;
    case "doc":
      return typeof key === "string" && key.length > 0 && key.length <= 200
        ? `/knowledge/docs/${encodeURIComponent(key)}/edit`
        : undefined;
    // Web chưa có trang một task hay một dự án theo mã nên mở danh sách, như app desktop.
    case "task":
      return "/tasks";
    case "projectSettings":
      return "/projects";
    default:
      return undefined;
  }
}

export async function openHubPage(link: unknown): Promise<boolean> {
  const path = hubPathOf(link);
  if (!path) return false;
  const hub = config.hubUrl();
  if (!hub) {
    void vscode.window.showWarningMessage(t("sdlc.noHub"));
    return false;
  }
  const url = `${hub}${path}`;
  if (!isAllowedLink(url, hub)) {
    void vscode.window.showWarningMessage(t("sdlc.unsafeLink"));
    return false;
  }
  return vscode.env.openExternal(vscode.Uri.parse(url));
}

interface Mounted {
  dispose(): void;
  /** Đưa webview tới một màn; nếu màn chưa nạp xong thì giữ lại cho đến khi nó hỏi `sdlcInit`. */
  navigate(route: SdlcRoute): void;
}

/** Gắn cầu nối của màn `sdlc` kèm hai kênh riêng với host; thủ tục khác đi tiếp tới transport của hub. */
function mount(webview: vscode.Webview, ctx: vscode.ExtensionContext, initial?: SdlcRoute): Mounted {
  let pending = initial;
  let loaded = false;
  const rpc = async (request: RpcRequest, signal: AbortSignal): Promise<RpcReply> => {
    switch (request.path) {
      case "/rpc/host/sdlcInit": {
        loaded = true;
        const route = pending ?? null;
        pending = undefined;
        return json({ route });
      }
      case "/rpc/host/sdlcOpen": {
        let link: unknown;
        try {
          link = JSON.parse(request.body ?? "null");
        } catch {
          return json(false, 400);
        }
        return json(await openHubPage(link));
      }
    }
    const transport = getRpcTransport();
    return transport
      ? transport(request, signal)
      : json(
          { json: { defined: false, code: "SERVICE_UNAVAILABLE", status: 503, message: t("webview.unavailable") } },
          503,
        );
  };
  const bridge = attachBridge(webview, "sdlc", { rpc });
  webview.html = renderHtml(webview, ctx.extensionUri, "sdlc");
  return {
    dispose: () => bridge.dispose(),
    navigate(route) {
      if (loaded) void webview.postMessage({ type: "sdlc.navigate", to: route });
      else pending = route;
    },
  };
}

/** Webview View ở thanh bên (`xdev-hive.sdlc` trong manifest). */
export function registerSdlcView(ctx: vscode.ExtensionContext): vscode.Disposable {
  const active = new Set<Mounted>();
  const provider = vscode.window.registerWebviewViewProvider(SDLC_VIEW, {
    resolveWebviewView(view) {
      view.webview.options = webviewOptions(ctx.extensionUri);
      const mounted = mount(view.webview, ctx);
      active.add(mounted);
      const closed = view.onDidDispose(() => {
        mounted.dispose();
        active.delete(mounted);
        closed.dispose();
      });
    },
  });
  const registration = new vscode.Disposable(() => {
    provider.dispose();
    for (const mounted of active) mounted.dispose();
    active.clear();
  });
  ctx.subscriptions.push(registration);
  return registration;
}

/**
 * Mở màn AI SDLC trong panel ở vùng soạn thảo (thanh bên hẹp cho chi tiết hạng mục). Một panel dùng lại cho mọi
 * lần mở: đã có thì đưa lên và chuyển màn.
 */
export function registerSdlcPanel(ctx: vscode.ExtensionContext): (route?: SdlcRoute) => void {
  let current: { panel: vscode.WebviewPanel; mounted: Mounted } | undefined;
  const open = (route: SdlcRoute = { kind: "board" }) => {
    if (current) {
      current.panel.reveal();
      current.mounted.navigate(route);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "xdev-hive.sdlc",
      t("webview.sdlc"),
      vscode.ViewColumn.Active,
      webviewOptions(ctx.extensionUri),
    );
    const mounted = mount(panel.webview, ctx, route);
    current = { panel, mounted };
    const closed = panel.onDidDispose(() => {
      mounted.dispose();
      closed.dispose();
      current = undefined;
    });
    ctx.subscriptions.push(panel, closed);
  };
  ctx.subscriptions.push(
    vscode.commands.registerCommand(SDLC_OPEN_COMMAND, (route?: SdlcRoute) => open(route)),
    {
      dispose: () => {
        current?.panel.dispose();
      },
    },
  );
  return open;
}

export function register(ctx: vscode.ExtensionContext): void {
  registerSdlcView(ctx);
  registerSdlcPanel(ctx);
}
