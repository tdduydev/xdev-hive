// Chỉ dùng trong test: máy chủ HTTP thật trên 127.0.0.1 để giả Jenkins, Argo CD, Kubernetes. Dùng chung cho các client
// của module delivery, nên không phụ thuộc vào client nào.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeRequest {
  method: string;
  /** Chỉ phần đường dẫn, không có query. Đây là khoá để khớp route. */
  pathname: string;
  /** Đường dẫn kèm query, đúng như client gửi. */
  url: string;
  query: URLSearchParams;
  /** Tên header viết thường. */
  headers: Record<string, string>;
  body: string;
}

export interface FakeResponse {
  status?: number;
  headers?: Record<string, string>;
  /** Có `json` thì tự thêm `content-type: application/json`. */
  json?: unknown;
  body?: string | Buffer;
  /** Trễ trước khi trả lời, để thử hết giờ. */
  delayMs?: number;
}

/** `n` là số lần route này đã được gọi trước lần hiện tại (từ 0). */
export type FakeHandler = FakeResponse | ((req: FakeRequest, n: number) => FakeResponse | Promise<FakeResponse>);

/**
 * Khoá là `"METHOD /đường/dẫn"`. Giá trị là một phản hồi, một hàm, hoặc một dãy phản hồi trả lần lượt (lần cuối lặp lại
 * mãi) để giả việc trạng thái đổi theo thời gian, ví dụ queue item.
 */
export type FakeRoutes = Record<string, FakeHandler | FakeHandler[]>;

export interface FakeHttp {
  /** Địa chỉ gốc, không có dấu `/` cuối. */
  baseUrl: string;
  /** Mọi yêu cầu đã nhận, kể cả yêu cầu không khớp route. */
  requests: FakeRequest[];
  /** Thêm hoặc thay route khi đang chạy. */
  route(key: string, handler: FakeHandler | FakeHandler[]): void;
  /** Các lần gọi tới route `key` (không tính query). */
  callsTo(key: string): FakeRequest[];
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function headersOf(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(", ") : v;
  return out;
}

export async function startFakeHttp(routes: FakeRoutes = {}): Promise<FakeHttp> {
  const table = new Map<string, FakeHandler | FakeHandler[]>(Object.entries(routes));
  const counts = new Map<string, number>();
  const requests: FakeRequest[] = [];
  const sockets = new Set<import("node:net").Socket>();

  const server: Server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    const parsed = new URL(url, "http://fake.invalid");
    const fake: FakeRequest = {
      method: req.method ?? "GET",
      pathname: parsed.pathname,
      url,
      query: parsed.searchParams,
      headers: headersOf(req),
      body: await readBody(req),
    };
    requests.push(fake);

    const key = `${fake.method} ${fake.pathname}`;
    const entry = table.get(key);
    let response: FakeResponse;
    if (entry === undefined) {
      response = { status: 404, body: `fake-http: không có route ${key}` };
    } else {
      const n = counts.get(key) ?? 0;
      counts.set(key, n + 1);
      const handler = Array.isArray(entry) ? entry[Math.min(n, entry.length - 1)] : entry;
      if (handler === undefined) {
        response = { status: 500, body: `fake-http: route ${key} rỗng` };
      } else {
        response = typeof handler === "function" ? await handler(fake, n) : handler;
      }
    }

    if (response.delayMs) await new Promise((r) => setTimeout(r, response.delayMs));
    // Client đã bỏ (hết giờ) thì không ghi nữa.
    if (res.destroyed) return;
    const headers = { ...response.headers };
    let payload: string | Buffer = response.body ?? "";
    if (response.json !== undefined) {
      payload = JSON.stringify(response.json);
      headers["content-type"] ??= "application/json";
    }
    res.writeHead(response.status ?? 200, headers);
    res.end(payload);
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    route: (key, handler) => {
      table.set(key, handler);
      counts.delete(key);
    },
    callsTo: (key) => requests.filter((r) => `${r.method} ${r.pathname}` === key),
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Kết nối keep-alive và yêu cầu đang trễ sẽ giữ server mở mãi nếu không cắt.
        for (const s of sockets) s.destroy();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
