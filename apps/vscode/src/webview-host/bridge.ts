import * as vscode from "vscode";
import { config } from "@/lib/config.ts";
import { t } from "@/lib/i18n.ts";
import { redact } from "@/lib/redact.ts";
import { ALLOWED_PROCEDURES } from "@/webview-host/allowlist/index.ts";
import type { WebviewScreen } from "@/webview-host/html.ts";
import { getRpcTransport } from "@/webview-host/transport.ts";
import type { RpcReply, RpcTransport } from "@/webview-host/types.ts";
import "@/webview-host/strings.ts";

export type { RpcReply, RpcRequest, RpcTransport } from "@/webview-host/types.ts";

const MAX_BYTES = 1024 * 1024;
const MAX_PENDING = 32;

interface BridgeOptions {
  rpc?: RpcTransport;
  hubUrl?: () => string;
  procedures?: readonly string[];
}

function errorReply(status: number, code: string, key: string): RpcReply {
  return {
    status,
    contentType: "application/json",
    body: JSON.stringify({ json: { defined: false, code, status, message: t(key) } }),
  };
}

export function isAllowedLink(value: string, hubUrl: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    const hub = new URL(hubUrl);
    return url.protocol === "http:" && hub.protocol === "http:" && url.origin === hub.origin;
  } catch {
    return false;
  }
}

/** Mỗi webview giữ allowlist và hàng yêu cầu riêng; thông điệp không được tự chọn màn hay hub. */
export function attachBridge(
  webview: vscode.Webview,
  screen: WebviewScreen,
  options: BridgeOptions = {},
): vscode.Disposable {
  const allowed = new Set(options.procedures ?? ALLOWED_PROCEDURES[screen]);
  const pending = new Map<string, AbortController>();
  let disposed = false;
  const listener = webview.onDidReceiveMessage(async (value: unknown) => {
    if (disposed || !value || typeof value !== "object") return;
    const message = value as Record<string, unknown>;
    const { id, type } = message;
    if (typeof id !== "string" || !/^[\w-]{1,128}$/.test(id)) return;
    if (type === "cancel") {
      pending.get(id)?.abort();
      return;
    }
    if (pending.has(id)) return;
    const respond = async (reply: RpcReply) => {
      try {
        if (!disposed) await webview.postMessage({ type: "result", id, ...reply, body: redact(reply.body) });
      } catch {
        // Webview có thể vừa bị đóng trong lúc host gửi phản hồi.
      }
    };
    if (pending.size >= MAX_PENDING) {
      await respond(errorReply(429, "TOO_MANY_REQUESTS", "webview.failed"));
      return;
    }
    const controller = new AbortController();
    pending.set(id, controller);
    try {
      let reply: RpcReply;
      if (type === "rpc") {
        const { path, method, body } = message;
        if (
          typeof path !== "string" ||
          path.length > MAX_BYTES ||
          !/^\/rpc\/[A-Za-z][A-Za-z0-9]*(?:\/[A-Za-z][A-Za-z0-9]*)*(?:\?[^#]*)?$/.test(path) ||
          (method !== "GET" && method !== "POST") ||
          (body !== null && typeof body !== "string") ||
          (typeof body === "string" && Buffer.byteLength(body) > MAX_BYTES) ||
          (method === "GET" && body !== null)
        ) {
          reply = errorReply(400, "BAD_REQUEST", "webview.invalid");
        } else if (!allowed.has(path.split("?")[0] ?? "")) {
          reply = errorReply(403, "FORBIDDEN", "webview.forbidden");
        } else {
          const rpc = options.rpc ?? getRpcTransport();
          reply = rpc
            ? await rpc({ path, method, body }, controller.signal)
            : errorReply(503, "SERVICE_UNAVAILABLE", "webview.unavailable");
        }
      } else if (
        type === "clipboard.write" &&
        typeof message.text === "string" &&
        Buffer.byteLength(message.text) <= MAX_BYTES
      ) {
        await vscode.env.clipboard.writeText(message.text);
        reply = { status: 200, contentType: "application/json", body: "true" };
      } else if (
        type === "download" &&
        typeof message.text === "string" &&
        Buffer.byteLength(message.text) <= MAX_BYTES
      ) {
        // Webview không được chọn đường dẫn ghi; người dùng chọn đích qua hộp thoại của VS Code.
        const uri = await vscode.window.showSaveDialog({ saveLabel: t("webview.save") });
        if (uri && !controller.signal.aborted)
          await vscode.workspace.fs.writeFile(uri, Buffer.from(message.text, "utf8"));
        reply = { status: 200, contentType: "application/json", body: String(Boolean(uri)) };
      } else if (
        type === "openExternal" &&
        typeof message.url === "string" &&
        isAllowedLink(message.url, (options.hubUrl ?? config.hubUrl)())
      ) {
        const opened = await vscode.env.openExternal(vscode.Uri.parse(message.url));
        reply = { status: 200, contentType: "application/json", body: String(opened) };
      } else {
        reply = errorReply(400, "BAD_REQUEST", "webview.invalid");
      }
      if (!controller.signal.aborted) await respond(reply);
    } catch {
      // Lỗi từ transport có thể chứa header hoặc token, chỉ trả thông báo cố định về webview.
      if (!controller.signal.aborted) await respond(errorReply(500, "INTERNAL_SERVER_ERROR", "webview.failed"));
    } finally {
      pending.delete(id);
    }
  });
  return new vscode.Disposable(() => {
    disposed = true;
    listener.dispose();
    for (const controller of pending.values()) controller.abort();
    pending.clear();
  });
}
