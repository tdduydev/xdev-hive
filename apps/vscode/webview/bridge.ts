import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { type ContractRouterClient, inferRPCMethodFromContractRouter } from "@orpc/contract";
import { type Contract, contract } from "@xdev-hive/contracts";

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): T;
}

declare function acquireVsCodeApi(): VsCodeApi;

interface Reply {
  type: "result";
  id: string;
  status: number;
  body: string;
  contentType: string;
}

interface Pending {
  resolve(reply: Reply): void;
  reject(error: Error): void;
  cleanup(): void;
}

const messages = {
  vi: {
    failed: "Không thực hiện được thao tác.",
    timeout: "Yêu cầu quá thời gian chờ.",
    closed: "Màn hình đã đóng.",
    invalid: "Yêu cầu không hợp lệ.",
  },
  en: {
    failed: "The action failed.",
    timeout: "The request timed out.",
    closed: "The screen was closed.",
    invalid: "Invalid request.",
  },
};
const text = () => messages[document.documentElement.lang === "en" ? "en" : "vi"];

export class WebviewBridge {
  private readonly api: VsCodeApi;
  private readonly pending = new Map<string, Pending>();
  private disposed = false;

  constructor(api: VsCodeApi = acquireVsCodeApi()) {
    this.api = api;
    window.addEventListener("message", this.receive);
  }

  private readonly receive = (event: MessageEvent<unknown>) => {
    if (!event.data || typeof event.data !== "object") return;
    const reply = event.data as Partial<Reply>;
    if (
      reply.type !== "result" ||
      typeof reply.id !== "string" ||
      !Number.isInteger(reply.status) ||
      (reply.status ?? 0) < 100 ||
      (reply.status ?? 0) > 599 ||
      typeof reply.body !== "string" ||
      typeof reply.contentType !== "string"
    )
      return;
    const entry = this.pending.get(reply.id);
    if (!entry) return;
    this.pending.delete(reply.id);
    entry.cleanup();
    entry.resolve(reply as Reply);
  };

  private request(message: Record<string, unknown>, signal?: AbortSignal): Promise<Reply> {
    if (this.disposed) return Promise.reject(new Error(text().closed));
    if (signal?.aborted) return Promise.reject(new DOMException(text().failed, "AbortError"));
    if (this.pending.size >= 32) return Promise.reject(new Error(text().failed));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const cancel = (error: Error) => {
        this.pending.delete(id);
        cleanup();
        this.cancel(id);
        reject(error);
      };
      const abort = () => cancel(new DOMException(text().failed, "AbortError"));
      const timer = setTimeout(() => cancel(new Error(text().timeout)), 120_000);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.api.postMessage({ ...message, id });
      } catch {
        this.pending.delete(id);
        cleanup();
        reject(new Error(text().failed));
      }
    });
  }

  private cancel(id: string): void {
    try {
      this.api.postMessage({ type: "cancel", id });
    } catch {
      // Host có thể đã đóng; vẫn phải giải phóng promise và timer tại webview.
    }
  }

  readonly fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (
      url.origin !== "https://hive.invalid" ||
      !url.pathname.startsWith("/rpc/") ||
      (request.method !== "GET" && request.method !== "POST")
    ) {
      throw new Error(text().invalid);
    }
    const reply = await this.request(
      {
        type: "rpc",
        method: request.method,
        path: url.pathname + url.search,
        body: request.method === "GET" ? null : await request.text(),
      },
      request.signal,
    );
    return new Response(reply.status === 204 || reply.status === 205 || reply.status === 304 ? null : reply.body, {
      status: reply.status,
      headers: { "content-type": reply.contentType },
    });
  };

  private async action(message: Record<string, unknown>): Promise<boolean> {
    const reply = await this.request(message);
    if (reply.status >= 400) throw new Error(text().failed);
    return JSON.parse(reply.body) === true;
  }

  writeClipboard(text: string): Promise<boolean> {
    return this.action({ type: "clipboard.write", text });
  }

  download(text: string): Promise<boolean> {
    return this.action({ type: "download", text });
  }

  openExternal(url: string): Promise<boolean> {
    return this.action({ type: "openExternal", url });
  }

  getState<T>(): T | undefined {
    return this.api.getState<T>();
  }

  setState<T>(state: T): T {
    return this.api.setState(state);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener("message", this.receive);
    for (const [id, entry] of this.pending) {
      entry.cleanup();
      this.cancel(id);
      entry.reject(new Error(text().closed));
    }
    this.pending.clear();
  }
}

// Giữ API của VS Code trong module để component chỉ truy cập qua cầu nối.
export const bridge = new WebviewBridge();
window.addEventListener("pagehide", () => bridge.dispose(), { once: true });

export const hub: ContractRouterClient<Contract> = createORPCClient(
  new RPCLink({
    url: "https://hive.invalid/rpc",
    method: inferRPCMethodFromContractRouter(contract),
    fetch: bridge.fetch,
  }),
);
